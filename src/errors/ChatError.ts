/**
 * caloplan-chat 统一错误类型。
 *
 * 分类（`kind`）以 fastapi-chat-service 实际错误行为准：
 * - `network`：fetch 失败 / 网络不可达
 * - `auth`：缺少 Token、401 认证失败、403 权限不足（chat 请求）
 * - `backend`：后端返回的其他 HTTP 错误 / 响应不是合法 JSON
 * - `stream`：SSE 流内错误（`{"type":"error"}` 事件）、流中断 / SSE 解析失败
 * - `confirmation`：审批专属错误 —— taskid 不存在 / 已过期（410）、越权（403）
 * - `cache`：caloplan-cache 读写失败（本地历史缓存）
 *
 * SDK 不负责 Token 刷新 / 重新登录：401 时抛出 `ChatError(kind=auth)`，
 * 由上层 UI 决定如何处理。
 */

export type ChatErrorKind =
  | "network"
  | "auth"
  | "backend"
  | "stream"
  | "confirmation"
  | "cache";

export interface ChatErrorOptions {
  /** HTTP 状态码（如有） */
  status?: number;
  /** 后端结构化错误码（`AIErrorDetail.code`，若返回） */
  code?: string;
  /** 是否可重试（后端 `AIErrorDetail.retryable`，若返回） */
  retryable?: boolean;
  cause?: unknown;
}

export class ChatError extends Error {
  readonly kind: ChatErrorKind;
  readonly status?: number;
  readonly code?: string;
  readonly retryable: boolean;

  constructor(kind: ChatErrorKind, message: string, options: ChatErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ChatError";
    this.kind = kind;
    this.status = options.status;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
  }
}

export function isChatError(err: unknown): err is ChatError {
  return err instanceof ChatError;
}

/** 将 cache 层抛出的任意异常包装为 ChatError（kind=cache），保留原始 cause */
export function toCacheError(context: string, err: unknown): ChatError {
  const detail = err instanceof Error ? err.message : String(err);
  return new ChatError("cache", `${context}失败：${detail}`, { cause: err });
}
