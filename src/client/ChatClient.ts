import { nanoid } from "nanoid";
import type {
  ChatContentBlock,
  ChatMessage,
  ChatToolCallRecord,
  ChatUsage,
  PendingAction,
} from "../models/ChatMessage.js";
import { ChatHistory } from "../history/ChatHistory.js";
import type { ChatCacheLike } from "../history/ChatHistory.js";
import { ChatTransport } from "../transport/ChatTransport.js";
import type { ChatTransportOptions } from "../transport/ChatTransport.js";
import {
  mapApprovalEvent,
  mapChatResponse,
  mapToolCallResults,
  toBackendContent,
  toBackendHistory,
} from "../mapper/ChatMapper.js";
import type { BackendApprovalResponse } from "../transport/types.js";
import { ChatError } from "../errors/ChatError.js";

/**
 * caloplan-chat 主入口。
 *
 * 职责边界：
 * - 对接 fastapi-chat-service（请求封装、Bearer Token 透传、审批流）；
 * - 通过 caloplan-cache 管理本地聊天记录（Session / Message）；
 * - **不负责**：登录 / 注册 / Token 刷新（由外部 tokenProvider 注入）、
 *   UI（弹窗 / Modal / 样式）、全局状态、LocalStorage 底层实现。
 *
 * 框架无关：纯 TypeScript，Vue / React / React Native / Web 通用。
 */

export interface ChatClientOptions {
  /** fastapi-chat-service 根地址，如 `http://localhost:9095` */
  baseURL: string;
  /**
   * 外部注入的 Token 提供器（返回 JWT 或 Promise<JWT>）。
   * 登录 / 刷新 / 认证生命周期由上层负责，SDK 仅透传。
   */
  tokenProvider: () => string | null | Promise<string | null>;
  /** 已初始化的 caloplan-cache 实例（或兼容其契约的缓存实现） */
  cache: ChatCacheLike;
  /** 可注入的 fetch 实现（测试 / RN 适配用） */
  fetchImpl?: typeof fetch;
}

/** 一次发送消息的结果（流式 done 终态事件携带） */
export interface ChatSendResult {
  sessionId: string;
  /** 已持久化的用户消息 */
  userMessage: ChatMessage;
  /**
   * 已持久化的 assistant 消息：
   * - 普通回复：content=回复内容，status=completed；
   * - 需要审批：content=""，status=completed，pendingAction 非空（UI 据此展示确认卡片）；
   * - 请求失败：status=failed（此时流以 ChatError 抛出，无 done 事件）。
   */
  assistantMessage: ChatMessage;
  conversationId: string;
  /** 是否命中需审批 Tool（为 true 时调用 chat.confirm(taskid) / chat.cancel(taskid)） */
  needApproval: boolean;
  /** 本次实际执行的工具调用记录（仅展示用，不持久化） */
  toolCalls: ChatToolCallRecord[];
  /** 本次回复的 Token 使用量 */
  usage: ChatUsage;
}

/**
 * sendMessage 流式事件（按序产出）：
 * - `text_delta`：文本增量（可多次）。`assistantMessage` 为 SDK 内部累积后的实时对象
 *   （content / status 已同步写回 cache），UI 可直接读取渲染；
 * - `approval`：命中需审批 Tool（其后必有 `done`）；`pendingAction` 已挂到 assistant 消息并持久化；
 * - `done`：流式完成，携带最终结果。
 * 流内错误（后端 error 事件 / 流中断）直接以 ChatError 抛出，不产出 error 事件。
 */
export type ChatStreamEvent =
  | { type: "text_delta"; content: string; assistantMessage: ChatMessage }
  | { type: "approval"; pendingAction: PendingAction }
  | { type: "done"; result: ChatSendResult };

/** 审批决定（confirm / cancel）的结果 */
export interface ChatConfirmResult {
  taskid: string;
  approved: boolean;
  /** 最终回复（拒绝时不执行 tool，模型照常给最终回复） */
  reply: string;
  /** 批准执行后实际执行的工具结果 */
  toolResults: ChatToolCallRecord[];
  /** 本次回复的 Token 使用量 */
  usage: ChatUsage;
}

export class ChatClient {
  /** 会话 / 消息本地历史入口（chat.sessions.list() / create() / ...） */
  readonly sessions: ChatHistory;
  private readonly history: ChatHistory;
  private readonly transport: ChatTransport;

  constructor(options: ChatClientOptions) {
    this.history = new ChatHistory(options.cache);
    this.sessions = this.history;
    this.transport = new ChatTransport({
      baseURL: options.baseURL,
      tokenProvider: options.tokenProvider,
      fetchImpl: options.fetchImpl,
    });
  }

  /**
   * 从 cache 恢复本地历史（幂等）。写操作内部会自动 init；
   * 若想 `sessions.list()` 立刻读到恢复后的数据，请先 `await chat.init()`。
   */
  init(): Promise<void> {
    return this.history.init();
  }

  /**
   * 发送消息（SSE 流式）。
   *
   * `content` 支持纯文本，或内容块数组（text / image_url，可含 base64 data URL 图片，
   * 对齐后端 `ChatRequest.message: str | list[ContentBlock]`）。
   *
   * 生命周期（无论请求成败，用户消息与历史均不丢失）：
   * 1. 创建 user 消息 → **立即写回 cache**（不等待后端返回）；
   * 2. 创建 assistant 消息（status=streaming）→ 写回 cache；
   * 3. 请求 fastapi-chat-service（stream=true），逐事件处理：
   *    - text 增量 → 累积 content → **实时 updateMessage 写回 cache** → yield `text_delta`；
   *    - approval（需审批）→ 挂 pendingAction 写回 → yield `approval`；
   *    - done → assistant 置 completed（普通回复填完整 reply）→ yield `done`；
   *    - error 事件 → assistant 置 failed（保留已收内容）→ 抛 ChatError(kind=stream)。
   * 4. 网络 / HTTP / 流中断错误：assistant 置 failed 并写回，然后抛出 ChatError。
   *
   * 用法：
   * ```ts
   * const stream = chat.sendMessage(session.id, "帮我分析今天的营养摄入");
   * for await (const ev of stream) {
   *   if (ev.type === "text_delta") ui.update(ev.assistantMessage.content);
   *   if (ev.type === "approval") ui.showConfirm(ev.pendingAction);
   *   if (ev.type === "done") ui.finish(ev.result);
   * }
   * ```
   */
  async *sendMessage(
    sessionId: string,
    content: string | ChatContentBlock[],
  ): AsyncGenerator<ChatStreamEvent, void, unknown> {
    const message = validateContent(content);
    await this.history.init();
    const session = this.sessions.get(sessionId);
    if (session == null) {
      throw new Error(`会话不存在：${sessionId}`);
    }
    // 发送前快照：history 只回传“本条消息之前”的已完成消息
    // （后端 agent.run(message, message_history=history)，本条消息走 message 字段，避免重复）
    const priorMessages = session.messages.slice();

    // 1. 用户消息先落盘（请求失败也不丢用户输入）
    const userMessage: ChatMessage = {
      id: nanoid(),
      role: "user",
      content: message,
      status: "completed",
      createdAt: Date.now(),
    };
    await this.history.appendMessage(sessionId, userMessage);

    // 2. assistant 占位（streaming）→ 写回 cache
    const assistantMessage: ChatMessage = {
      id: nanoid(),
      role: "assistant",
      content: "",
      status: "streaming",
      createdAt: Date.now(),
    };
    await this.history.appendMessage(sessionId, assistantMessage);

    let accumulated = "";
    let pendingAction: PendingAction | undefined;
    let conversationId = "";
    let needApproval = false;
    let toolCalls: ChatToolCallRecord[] = [];
    let usage: ChatUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    let receivedDone = false;

    try {
      // 3. 流式请求
      for await (const event of this.transport.chatStream({
        message:
          typeof message === "string" ? message : toBackendContent(message),
        conversation_id: sessionId,
        history: toBackendHistory(priorMessages),
      })) {
        switch (event.type) {
          case "text": {
            // 累积增量 → 实时写回 cache → yield 增量事件
            accumulated += event.content;
            await this.history.updateMessage(sessionId, assistantMessage.id, {
              content: accumulated,
              status: "streaming",
            });
            yield { type: "text_delta", content: event.content, assistantMessage };
            break;
          }
          case "approval": {
            pendingAction = mapApprovalEvent(event);
            await this.history.updateMessage(sessionId, assistantMessage.id, {
              pendingAction,
            });
            yield { type: "approval", pendingAction };
            break;
          }
          case "done": {
            receivedDone = true;
            const mapped = mapChatResponse(event);
            conversationId = mapped.conversationId;
            needApproval = mapped.needApproval;
            toolCalls = mapped.toolCalls;
            usage = mapped.usage;
            if (needApproval) {
              // 审批分支：pendingAction 已在 approval 事件时挂载，这里仅置 completed + 挂载 toolCalls/usage
              await this.history.updateMessage(sessionId, assistantMessage.id, {
                status: "completed",
                toolCalls,
                usage,
              });
            } else {
              // 正常分支：以 done.reply 为权威完整文本
              accumulated = mapped.reply;
              await this.history.updateMessage(sessionId, assistantMessage.id, {
                content: accumulated,
                status: "completed",
                toolCalls,
                usage,
              });
            }
            yield {
              type: "done",
              result: {
                sessionId,
                userMessage,
                assistantMessage,
                conversationId,
                needApproval,
                toolCalls,
                usage,
              },
            };
            break;
          }
          case "error": {
            // 后端 AI 调用失败：SSE error 事件（HTTP 仍为 200）
            throw new ChatError("stream", `AI 流式调用失败：${event.detail}`);
          }
        }
      }

      // 防御：流正常结束但从未收到 done 终态（空 body / 提前中断 / 协议不匹配）
      if (!receivedDone) {
        throw new ChatError("stream", "流提前结束：未收到 done 终态");
      }
    } catch (err) {
      // 4. 失败：assistant 标记 failed（保留已收内容）并写回；主错误优先抛出
      await this.history
        .updateMessage(sessionId, assistantMessage.id, { status: "failed" })
        .catch(() => undefined);
      throw err;
    }
  }

  /** 批准审批动作：执行需审批的 tool，并返回最终回复 */
  async confirm(taskid: string): Promise<ChatConfirmResult> {
    return this.resolveApproval(taskid, true);
  }

  /** 拒绝审批动作：不执行 tool，模型照常给出最终回复 */
  async cancel(taskid: string): Promise<ChatConfirmResult> {
    return this.resolveApproval(taskid, false);
  }

  private async resolveApproval(
    taskid: string,
    approved: boolean,
  ): Promise<ChatConfirmResult> {
    await this.history.init();
    const response = await this.transport.approval({ taskid, approved });
    const toolResults = mapToolCallResults(response.tool_results ?? []);
    const usage: ChatUsage = {
      promptTokens: response.usage?.prompt_tokens ?? 0,
      completionTokens: response.usage?.completion_tokens ?? 0,
      totalTokens: response.usage?.total_tokens ?? 0,
    };
    await this.applyApprovalResult(taskid, approved, response, toolResults, usage);
    return {
      taskid,
      approved: response.approved,
      reply: response.reply,
      toolResults,
      usage,
    };
  }

  /**
   * 审批成功后更新本地历史：
   * - 挂载该 taskid 的 assistant 消息：pendingAction → resolved；
   * - 若后端返回了最终回复，追加为一条新的 assistant 消息（历史完整，可回读）。
   */
  private async applyApprovalResult(
    taskid: string,
    approved: boolean,
    response: BackendApprovalResponse,
    toolResults: ChatToolCallRecord[],
    usage: ChatUsage,
  ): Promise<void> {
    const found = this.history.findPendingAction(taskid);
    if (found == null) return; // 本地无记录（如会话已被删除）：仅返回结果，不写历史
    const { sessionId, message } = found;

    if (message.pendingAction != null) {
      await this.history.updateMessage(sessionId, message.id, {
        pendingAction: {
          ...message.pendingAction,
          resolved: true,
          outcome: approved ? "approved" : "cancelled",
        },
      });
    }

    if (response.reply !== "") {
      const replyMessage: ChatMessage = {
        id: nanoid(),
        role: "assistant",
        content: response.reply,
        status: "completed",
        createdAt: Date.now(),
        toolCalls: toolResults,
        usage,
      };
      await this.history.appendMessage(sessionId, replyMessage);
    }
  }
}

/**
 * 校验并规范化发送内容（对齐后端 `ChatRequest.message` 语义）：
 * - string：trim 后非空，返回 trim 结果；
 * - 内容块数组：至少包含一个有效块（非空 text / 非空 image_url），原样返回。
 */
function validateContent(
  content: string | ChatContentBlock[],
): string | ChatContentBlock[] {
  if (typeof content === "string") {
    const trimmed = content.trim();
    if (trimmed === "") {
      throw new Error("消息内容不能为空");
    }
    return trimmed;
  }
  if (content.length === 0) {
    throw new Error("消息内容不能为空");
  }
  const hasValidBlock = content.some((block) =>
    block.type === "text"
      ? Boolean(block.text?.trim())
      : Boolean(block.imageUrl),
  );
  if (!hasValidBlock) {
    throw new Error("消息内容不能为空（需至少一个有效的 text / image_url 块）");
  }
  return content;
}
