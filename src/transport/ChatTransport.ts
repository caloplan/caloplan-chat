import { ChatError } from "../errors/ChatError.js";
import type {
  BackendApprovalRequest,
  BackendApprovalResponse,
  BackendChatRequest,
  BackendErrorBody,
  BackendStreamEvent,
} from "./types.js";

/**
 * 轻量 HTTP 封装（fetch）：请求 fastapi-chat-service，Bearer Token 注入 + 错误分类。
 *
 * - 不混入任何聊天业务逻辑（历史组装 / 消息落盘由上层负责）；
 * - 使用全局 fetch（Node 18+ / 浏览器 / RN 均可用），不引入大型 HTTP 框架；
 * - `chatStream` 解析 SSE（`data: <json>\n\n` 帧），产出后端流事件；
 * - 支持注入 `fetchImpl` 便于测试与特殊运行环境适配；
 * - Token 仅透传，登录 / 刷新 / 生命周期由外部 `tokenProvider` 负责。
 */

export interface ChatTransportOptions {
  /** fastapi-chat-service 根地址，如 `http://localhost:9095`（末尾斜杠自动去除） */
  baseURL: string;
  /**
   * 外部注入的 Token 提供器：返回 JWT 字符串；返回 null / 空串表示无登录态
   * （此时将抛出 kind=auth 的 ChatError，不发起请求）。
   */
  tokenProvider: () => string | null | Promise<string | null>;
  /** 可注入的 fetch 实现（默认全局 fetch） */
  fetchImpl?: typeof fetch;
}

/** 请求操作上下文：用于错误归类（审批的 403/410 → confirmation） */
export type ChatOperation = "chat" | "approval";

/** 后端 SSE 事件类型白名单 */
const KNOWN_STREAM_TYPES = new Set(["text", "approval", "done", "error"]);

export class ChatTransport {
  private readonly baseURL: string;
  private readonly tokenProvider: () => string | null | Promise<string | null>;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ChatTransportOptions) {
    this.baseURL = options.baseURL.replace(/\/+$/, "");
    this.tokenProvider = options.tokenProvider;
    // 绑定全局 fetch：原生 fetch 要求 this=Window，直接以成员方式调用会抛
    // "Failed to execute 'fetch' on 'Window': Illegal invocation"（Chrome/Edge）
    this.fetchImpl =
      options.fetchImpl ??
      ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init));
    if (typeof this.fetchImpl !== "function") {
      throw new Error(
        "ChatTransport 初始化失败：当前环境没有可用的 fetch（请注入 fetchImpl）",
      );
    }
  }

  /**
   * POST /api/v1/ai/chat（stream=true）：SSE 流式对话。
   * 逐帧产出后端事件：text（增量）→ approval（需审批）→ done（终态）；异常时 error 事件。
   * 注意：AI 调用失败时后端仍返回 HTTP 200，错误以 SSE `error` 事件表达（kind=stream）。
   */
  async *chatStream(
    body: BackendChatRequest,
  ): AsyncGenerator<BackendStreamEvent, void, unknown> {
    const token = await this.tokenProvider();
    if (token == null || token === "") {
      throw new ChatError("auth", "缺少访问令牌：tokenProvider 返回空", {
        code: "missing_token",
      });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseURL}/api/v1/ai/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ ...body, stream: true }),
      });
    } catch (err) {
      throw new ChatError(
        "network",
        `网络请求失败：${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw await this.classifyError(response, "chat");
    }
    if (response.body == null) {
      throw new ChatError("stream", "流式响应缺少 body");
    }

    try {
      for await (const frame of parseSse(response.body)) {
        const raw = frame as { type?: unknown };
        if (typeof raw.type !== "string" || !KNOWN_STREAM_TYPES.has(raw.type)) {
          throw new ChatError(
            "stream",
            `未知的 SSE 事件：${JSON.stringify(raw).slice(0, 120)}`,
          );
        }
        yield raw as BackendStreamEvent;
      }
    } catch (err) {
      if (err instanceof ChatError) throw err;
      throw new ChatError(
        "stream",
        `SSE 流读取/解析失败：${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }
  }

  /** POST /api/v1/ai/approval */
  async approval(
    body: BackendApprovalRequest,
  ): Promise<BackendApprovalResponse> {
    return this.request<BackendApprovalResponse>(
      "/api/v1/ai/approval",
      body,
      "approval",
    );
  }

  private async request<T>(
    path: string,
    body: unknown,
    op: ChatOperation,
  ): Promise<T> {
    const token = await this.tokenProvider();
    if (token == null || token === "") {
      throw new ChatError("auth", "缺少访问令牌：tokenProvider 返回空", {
        code: "missing_token",
      });
    }

    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseURL}${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new ChatError(
        "network",
        `网络请求失败：${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    if (!response.ok) {
      throw await this.classifyError(response, op);
    }

    try {
      return (await response.json()) as T;
    } catch (err) {
      throw new ChatError("backend", "响应不是合法 JSON", {
        status: response.status,
        cause: err,
      });
    }
  }

  /** 按状态码归类错误；尽力解析 FastAPI 的 `{detail}` / AIErrorDetail 的 `{code,message}` */
  private async classifyError(
    response: Response,
    op: ChatOperation,
  ): Promise<ChatError> {
    const status = response.status;
    let detail: string | undefined;
    let code: string | undefined;
    let retryable = false;
    try {
      const raw = (await response.json()) as BackendErrorBody;
      if (typeof raw.detail === "string") {
        detail = raw.detail;
      } else if (raw.detail != null && typeof raw.detail === "object") {
        const obj = raw.detail as { message?: unknown };
        detail =
          typeof obj.message === "string"
            ? obj.message
            : JSON.stringify(raw.detail);
      } else if (typeof raw.message === "string") {
        detail = raw.message;
      }
      if (typeof raw.code === "string") code = raw.code;
      if (typeof raw.retryable === "boolean") retryable = raw.retryable;
    } catch {
      // 错误体不是合法 JSON：忽略，用状态码兜底
    }
    const message = detail ?? `HTTP ${status}`;

    if (status === 401) {
      return new ChatError("auth", `认证失败（401）：${message}`, {
        status,
        code,
        retryable,
      });
    }
    if (status === 403) {
      if (op === "approval") {
        return new ChatError("confirmation", `审批越权（403）：${message}`, {
          status,
          code,
          retryable,
        });
      }
      return new ChatError("auth", `权限不足（403）：${message}`, {
        status,
        code,
        retryable,
      });
    }
    if (status === 410) {
      return new ChatError(
        "confirmation",
        `审批任务不存在或已过期（410）：${message}`,
        { status, code, retryable },
      );
    }
    return new ChatError("backend", `后端错误（${status}）：${message}`, {
      status,
      code,
      retryable,
    });
  }
}

/**
 * 解析 SSE 响应体（`data: <json>\n\n` 帧）为 JSON 对象。
 * - 逐帧解析，忽略 event:/id:/注释行；
 * - 兼容 `\r\n` 行尾；
 * - JSON 解析失败 / 读取中断会抛错（由 chatStream 包成 ChatError kind=stream）。
 */
async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<unknown, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const data = parseDataFrame(frame);
        if (data !== undefined) yield data;
      }
    }
    // 尾部残余帧（无 \n\n 结尾）
    const tail = parseDataFrame(buffer);
    if (tail !== undefined) yield tail;
  } finally {
    reader.releaseLock();
  }
}

/** 单帧 → JSON；无 data 行返回 undefined */
function parseDataFrame(frame: string): unknown | undefined {
  const dataLines: string[] = [];
  for (const line of frame.split("\n")) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.startsWith("data:")) {
      dataLines.push(trimmed.slice(5).trimStart());
    }
    // 忽略 event: / id: / 注释等行
  }
  if (dataLines.length === 0) return undefined;
  return JSON.parse(dataLines.join("\n"));
}
