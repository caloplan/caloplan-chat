import { nanoid } from "nanoid";
import type { ChatContentBlock, ChatMessage } from "../models/ChatMessage.js";
import type { ChatSession } from "../models/ChatSession.js";
import { toCacheError } from "../errors/ChatError.js";

/**
 * caloplan-cache 兼容契约（结构型接口，鸭子类型）。
 *
 * caloplan-chat **不直接操作 localStorage**，也不 import caloplan-cache 的运行时符号：
 * 只要注入的实例满足本接口即可 —— caloplan-cache 的 `Cache` 类天然满足
 * （`register / get / refresh / delete` 签名一致），因此：
 *
 * ```ts
 * import { createCPCache } from "caloplan-cache";
 * const chat = new ChatClient({ baseURL, tokenProvider, cache: createCPCache() });
 * ```
 *
 * cache 管“怎么存”（LocalStorage 序列化），chat 管“存什么”（本类决定数据结构与写入时机）。
 */
export interface ChatCacheLike {
  register(key: string, producer: () => unknown | Promise<unknown>): void;
  get<T>(key: string): Promise<T | null>;
  refresh<T>(key: string): Promise<T>;
  delete(key: string): void;
}

/** 聊天记录在 cache 中的默认 key */
export const CHAT_SESSIONS_CACHE_KEY = "chat_sessions";

/**
 * 本地聊天历史管理（Session / Message）。
 *
 * ## 缓存策略（写回式 read-through）
 *
 * 利用 caloplan-cache 的 producer 语义，**零修改**接入：
 * 1. 构造时 `cache.register(key, () => this.sessions)` —— producer 返回权威内存态；
 * 2. `init()` 调用 `cache.get(key)` —— localStorage 有数据则恢复；
 *    无数据则调用 producer（返回 `[]`）并写回空数组；
 * 3. 每次变更（create / appendMessage / updateMessage / delete / clear）：
 *    先改内存态，再 `cache.refresh(key)` —— producer 返回最新内存态并覆盖写回
 *    localStorage（整份 JSON 覆盖，聊天规模数据量级无压力）。
 *
 * 优点：不新增 cache 能力（cache 保持业务无关）、不直接触碰 localStorage、
 * 页面刷新后经 `init()` 完整恢复。
 */
export class ChatHistory {
  private readonly cache: ChatCacheLike;
  private readonly storageKey: string;
  private sessions: ChatSession[] = [];
  private initPromise: Promise<void> | null = null;

  constructor(cache: ChatCacheLike, storageKey: string = CHAT_SESSIONS_CACHE_KEY) {
    this.cache = cache;
    this.storageKey = storageKey;
    // 注册 producer：供 cache.get（冷启动回填）与 cache.refresh（每次变更写回）使用
    this.cache.register(storageKey, () => this.sessions);
  }

  /**
   * 从 cache（localStorage）恢复历史。幂等，可重复调用。
   * 写操作（create / appendMessage 等）内部会自动 init，因此非强制；
   * 若希望 `list()` / `get()` 在第一时间读到历史，请在创建后先 `await chat.init()`。
   */
  init(): Promise<void> {
    if (this.initPromise == null) {
      this.initPromise = this.hydrate();
    }
    return this.initPromise;
  }

  private async hydrate(): Promise<void> {
    try {
      const loaded = await this.cache.get<ChatSession[]>(this.storageKey);
      // 防御坏数据：非数组（如手改 localStorage）时丢弃，使用空历史
      if (Array.isArray(loaded)) {
        this.sessions = loaded;
      }
    } catch (err) {
      throw toCacheError("恢复聊天记录", err);
    }
  }

  /** 内存态 → 写回 cache（localStorage）；失败抛 ChatError（kind=cache） */
  private async persist(): Promise<void> {
    try {
      await this.cache.refresh(this.storageKey);
    } catch (err) {
      throw toCacheError("保存聊天记录", err);
    }
  }

  /* ── Session ── */

  /** 创建会话（自动生成 id / 时间戳，并立即写入 cache） */
  async create(params?: { title?: string }): Promise<ChatSession> {
    await this.init();
    const now = Date.now();
    const session: ChatSession = {
      id: nanoid(),
      title: params?.title ?? "",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.unshift(session); // 最新会话在前，便于列表展示
    await this.persist();
    return session;
  }

  /** 列出全部会话（内存态；调用前建议 `await chat.init()`） */
  list(): ChatSession[] {
    return this.sessions;
  }

  /** 按 id 获取会话；不存在返回 null */
  get(sessionId: string): ChatSession | null {
    return this.sessions.find((s) => s.id === sessionId) ?? null;
  }

  /** 删除会话（不存在时静默成功） */
  async delete(sessionId: string): Promise<void> {
    await this.init();
    const index = this.sessions.findIndex((s) => s.id === sessionId);
    if (index === -1) return;
    this.sessions.splice(index, 1);
    await this.persist();
  }

  /** 清空会话消息（保留会话本身）；返回更新后的会话，不存在返回 null */
  async clear(sessionId: string): Promise<ChatSession | null> {
    await this.init();
    const session = this.get(sessionId);
    if (session == null) return null;
    session.messages = [];
    session.updatedAt = Date.now();
    await this.persist();
    return session;
  }

  /* ── Message ── */

  /** 追加消息并写回 cache；第一条 user 消息自动生成会话标题 */
  async appendMessage(
    sessionId: string,
    message: ChatMessage,
  ): Promise<ChatSession> {
    await this.init();
    const session = this.requireSession(sessionId);
    session.messages.push(message);
    if (session.title === "" && message.role === "user") {
      session.title = makeTitle(message.content);
    }
    session.updatedAt = Date.now();
    await this.persist();
    return session;
  }

  /**
   * 更新消息（按需传 patch 字段）；返回更新后的消息，消息不存在返回 null。
   * 内部流程（请求成功 / 失败 / 审批解决）也经由本方法更新并落盘。
   */
  async updateMessage(
    sessionId: string,
    messageId: string,
    patch: Partial<
      Pick<ChatMessage, "content" | "status" | "pendingAction" | "toolCalls" | "usage">
    >,
  ): Promise<ChatMessage | null> {
    await this.init();
    const session = this.requireSession(sessionId);
    const message = session.messages.find((m) => m.id === messageId);
    if (message == null) return null;
    if (patch.content !== undefined) message.content = patch.content;
    if (patch.status !== undefined) message.status = patch.status;
    if (patch.pendingAction !== undefined) {
      message.pendingAction = patch.pendingAction;
    }
    if (patch.toolCalls !== undefined) message.toolCalls = patch.toolCalls;
    if (patch.usage !== undefined) message.usage = patch.usage;
    session.updatedAt = Date.now();
    await this.persist();
    return message;
  }

  /** 查找挂载了指定 taskid 的审批消息（供 confirm / cancel 更新本地记录） */
  findPendingAction(
    taskid: string,
  ): { sessionId: string; message: ChatMessage } | null {
    for (const session of this.sessions) {
      const message = session.messages.find(
        (m) => m.pendingAction?.taskid === taskid,
      );
      if (message != null) {
        return { sessionId: session.id, message };
      }
    }
    return null;
  }

  private requireSession(sessionId: string): ChatSession {
    const session = this.get(sessionId);
    if (session == null) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    return session;
  }
}

/** 由第一条 user 消息生成会话标题（压缩空白，截断 24 字；内容块数组取 text 块拼接） */
function makeTitle(content: string | ChatContentBlock[]): string {
  const text =
    typeof content === "string"
      ? content
      : content
          .filter((b): b is { type: "text"; text?: string } => b.type === "text")
          .map((b) => b.text ?? "")
          .join(" ");
  const trimmed = text.trim().replace(/\s+/g, " ");
  return trimmed.length > 24 ? `${trimmed.slice(0, 24)}…` : trimmed;
}
