/**
 * fastapi-chat-service wire 契约（snake_case，严格对齐后端 schema：
 * `app/schemas/ai/chat.py` / `approval.py` / `error.py`）。
 *
 * 仅类型定义，不含任何实现；映射逻辑见 `mapper/ChatMapper.ts`。
 */

export type BackendMessageRole = "system" | "user" | "assistant" | "tool";

/**
 * 内容块（后端 ContentBlock schema：`app/schemas/ai/chat.py`）。
 * OpenAI/DeepSeek 兼容：`{type:"text", text:"..."}` 或
 * `{type:"image_url", image_url: "url" | {"url": ...}}`（url / {"url"} 包裹 / base64 data URL 均可）。
 */
export type BackendContentBlock =
  | { type: "text"; text?: string }
  | { type: "image_url"; image_url: string | { url: string } };

/** 回传历史中的一条消息（后端 ChatMessage schema） */
export interface BackendChatMessage {
  role: BackendMessageRole;
  content: string | BackendContentBlock[];
  tool_calls?: BackendToolCall[];
  tool_call_id?: string;
}

export interface BackendToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

/** 模型推理参数（后端 ModelParams schema；本 SDK v1 不暴露，走服务端默认值） */
export interface BackendModelParams {
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  thinking?: boolean | null;
}

/** POST /api/v1/ai/chat 请求体（后端 ChatRequest schema） */
export interface BackendChatRequest {
  /**
   * 当前轮输入：纯文本，或 OpenAI/DeepSeek 风格内容块数组
   * （可含 image_url 图片：url 字符串 / {"url": ...} 包裹 / base64 data URL）。
   */
  message: string | BackendContentBlock[];
  /** 客户端生成的会话 ID，仅日志关联 / 幂等用（服务端零留存） */
  conversation_id?: string;
  history: BackendChatMessage[];
  params?: BackendModelParams;
  /** true 时以 SSE 流式返回（text 增量 + done 终态；审批分支发 approval 事件） */
  stream?: boolean;
}

export interface BackendUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface BackendToolCallResult {
  id: string;
  name: string;
  arguments?: Record<string, unknown> | null;
  result?: unknown;
}

/** 待审批工具调用（后端 PendingToolCall schema） */
export interface BackendPendingTool {
  tool_call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  description?: string | null;
}

/** POST /api/v1/ai/chat 响应（后端 ChatResponse schema，按 need_approval 区分分支） */
export interface BackendChatResponse {
  conversation_id: string;
  reply: string;
  model: string;
  usage: BackendUsage;
  latency_ms: number;
  tool_calls: BackendToolCallResult[];
  need_approval: boolean;
  taskid?: string | null;
  pending_tools?: BackendPendingTool[];
}

/** POST /api/v1/ai/approval 请求体（后端 ApprovalDecisionRequest schema） */
export interface BackendApprovalRequest {
  taskid: string;
  approved: boolean;
}

/** POST /api/v1/ai/approval 响应（后端 ApprovalDecisionResponse schema） */
export interface BackendApprovalResponse {
  conversation_id: string;
  reply: string;
  model: string;
  usage: BackendUsage;
  latency_ms: number;
  approved: boolean;
  tool_results: BackendToolCallResult[];
}

/** FastAPI / AIErrorDetail 错误响应体（尽力解析，非必需结构） */
export interface BackendErrorBody {
  detail?: unknown;
  code?: string;
  message?: string;
  retryable?: boolean;
}

/* ── SSE 流式（stream=true，data: <json> 帧）── */

/** SSE 文本增量事件 */
export interface BackendStreamTextEvent {
  type: "text";
  content: string;
}

/** SSE 审批事件（命中需审批 Tool；其后必有 done 终态） */
export interface BackendStreamApprovalEvent {
  type: "approval";
  taskid: string;
  pending_tools: BackendPendingTool[];
}

/** SSE 终态事件（字段与 ChatResponse 同构） */
export interface BackendStreamDoneEvent extends BackendChatResponse {
  type: "done";
}

/** SSE 错误事件（AI 调用失败；HTTP 状态仍为 200） */
export interface BackendStreamErrorEvent {
  type: "error";
  detail: string;
}

/** 后端 SSE 事件联合 */
export type BackendStreamEvent =
  | BackendStreamTextEvent
  | BackendStreamApprovalEvent
  | BackendStreamDoneEvent
  | BackendStreamErrorEvent;
