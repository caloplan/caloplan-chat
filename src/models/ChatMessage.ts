/**
 * 前端聊天消息模型（caloplan-chat 领域层，camelCase）。
 *
 * 与 fastapi-chat-service 的 wire 结构（snake_case）的映射见 `mapper/ChatMapper.ts`。
 */

/** 消息角色：与后端 MessageRole 对齐（system / user / assistant / tool） */
export type ChatMessageRole = "user" | "assistant" | "system" | "tool";

/**
 * 内容块（对齐后端 ContentBlock：text / image_url，可含 base64 data URL 图片）。
 * type 枚举值与后端一致（"text" | "image_url"），字段名 camelCase（imageUrl ↔ wire image_url）。
 */
export type ChatContentBlock =
  | { type: "text"; text?: string }
  | { type: "image_url"; imageUrl: string | { url: string } };

/**
 * 消息状态。
 *
 * 后端已支持 SSE 流式（`POST /api/v1/ai/chat?stream=true`，事件：text 增量 → done 终态；
 * 异常发 error 事件），因此状态为：
 * - `pending`：占位创建，尚未开始接收（保留供未来扩展 / 兼容）
 * - `streaming`：正在接收流（已收到部分增量，content 实时累积并写回 cache）
 * - `completed`：已完成（正常回复 / 等待审批的审批卡片 / 审批后的最终回复）
 * - `failed`：请求失败（用户消息不受影响；assistant 保留已收到的内容）
 */
export type ChatMessageStatus = "pending" | "streaming" | "completed" | "failed";

/** 待审批的工具调用（后端 `pending_tools[].{tool_call_id,name,arguments,description}` 映射） */
export interface PendingToolCall {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  description?: string;
}

/**
 * 待用户确认的审批动作。
 *
 * 后端命中需审批 Tool 时返回 `need_approval=true + taskid + pending_tools`；
 * 该对象挂载在触发审批的 assistant 消息上，随本地历史持久化（页面刷新后仍可确认，
 * taskid TTL 由后端控制，默认 300s）。
 */
export interface PendingAction {
  /** 后端审批任务 ID（confirm / cancel 的入参） */
  taskid: string;
  tools: PendingToolCall[];
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 是否已处理（confirm / cancel 成功后为 true） */
  resolved: boolean;
  /** 处理结果（resolved=true 后有效） */
  outcome?: "approved" | "cancelled";
}

/** 本次请求内实际执行的工具调用记录（后端 `tool_calls` / `tool_results` 映射，仅展示用，不持久化） */
export interface ChatToolCallRecord {
  id: string;
  name: string;
  arguments?: Record<string, unknown> | null;
  result?: unknown;
}

/** Token 使用量（后端 `usage` 映射，camelCase） */
export interface ChatUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ChatMessage {
  id: string;
  role: ChatMessageRole;
  /** 纯文本，或内容块数组（text / image_url，用于多模态 user 消息）；assistant 消息恒为 string */
  content: string | ChatContentBlock[];
  status: ChatMessageStatus;
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 触发审批时挂载；普通消息为 undefined */
  pendingAction?: PendingAction;
  /** 本次回复实际执行的工具调用（展示用：UI 可标注工具名，不展示参数） */
  toolCalls?: ChatToolCallRecord[];
  /** 本次回复的 Token 使用量（展示用：UI 可标注 total tokens） */
  usage?: ChatUsage;
}
