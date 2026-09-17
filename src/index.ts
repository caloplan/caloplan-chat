// ── 模型（前端领域层，camelCase）──
export type {
  ChatMessage,
  ChatMessageRole,
  ChatMessageStatus,
  ChatContentBlock,
  PendingAction,
  PendingToolCall,
  ChatToolCallRecord,
} from "./models/index.js";
export type { ChatSession } from "./models/index.js";

// ── ChatClient 主入口 ──
export { ChatClient } from "./client/ChatClient.js";
export type {
  ChatClientOptions,
  ChatSendResult,
  ChatConfirmResult,
  ChatStreamEvent,
} from "./client/ChatClient.js";

// ── 本地历史（经 caloplan-cache 持久化）──
export { ChatHistory, CHAT_SESSIONS_CACHE_KEY } from "./history/ChatHistory.js";
export type { ChatCacheLike } from "./history/ChatHistory.js";

// ── 传输层（HTTP 封装 + wire 契约）──
export { ChatTransport } from "./transport/ChatTransport.js";
export type {
  ChatTransportOptions,
  ChatOperation,
} from "./transport/ChatTransport.js";
export type {
  BackendChatMessage,
  BackendChatRequest,
  BackendChatResponse,
  BackendContentBlock,
  BackendApprovalRequest,
  BackendApprovalResponse,
  BackendPendingTool,
  BackendToolCallResult,
  BackendModelParams,
  BackendUsage,
  BackendErrorBody,
  BackendStreamEvent,
  BackendStreamTextEvent,
  BackendStreamApprovalEvent,
  BackendStreamDoneEvent,
  BackendStreamErrorEvent,
} from "./transport/types.js";

// ── 映射层 ──
export {
  toBackendHistory,
  mapChatResponse,
  mapApprovalEvent,
  mapToolCallResults,
} from "./mapper/ChatMapper.js";
export type { MappedChatResponse } from "./mapper/ChatMapper.js";

// ── 错误 ──
export { ChatError, isChatError, toCacheError } from "./errors/ChatError.js";
export type { ChatErrorKind, ChatErrorOptions } from "./errors/ChatError.js";

// ── caloplan-chat 单例：createCPChat() 初始化 / getCPChat() 获取 ──
export { createCPChat, getCPChat } from "./cpchat.js";
