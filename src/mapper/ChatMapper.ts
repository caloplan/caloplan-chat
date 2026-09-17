import type {
  ChatContentBlock,
  ChatMessage,
  ChatToolCallRecord,
  ChatUsage,
  PendingAction,
  PendingToolCall,
} from "../models/ChatMessage.js";
import type {
  BackendChatMessage,
  BackendChatResponse,
  BackendContentBlock,
  BackendStreamApprovalEvent,
  BackendToolCallResult,
} from "../transport/types.js";

/**
 * 前端模型（camelCase）↔ 后端 wire 契约（snake_case）的映射集中点。
 * ChatClient / ChatHistory 不直接手写 `response.xxx.xxx`。
 */

/** 前端内容块（camelCase：imageUrl）→ 后端 wire 内容块（snake_case：image_url） */
export function toBackendContent(
  blocks: ChatContentBlock[],
): BackendContentBlock[] {
  return blocks.map((block) =>
    block.type === "image_url"
      ? { type: "image_url", image_url: block.imageUrl }
      : { type: "text", text: block.text },
  );
}

/**
 * 组装回传历史（`toBackendHistory`）：
 *
 * 后端 `build_message_history`（app/ai/service.py）仅消费 user / assistant 消息：
 * - `system`：由服务端 AI_SYSTEM_PROMPT 管理，不回传；
 * - `tool`：由审批快照管理，无需客户端回传；
 * - `pending` / `failed` 消息不参与上下文（避免把未完成的回复发回模型）；
 * - 空 content 消息（空字符串 / 空内容块数组，如审批卡片 assistant）同样跳过。
 */
export function toBackendHistory(messages: ChatMessage[]): BackendChatMessage[] {
  const history: BackendChatMessage[] = [];
  for (const msg of messages) {
    if (msg.status !== "completed") continue;
    if (msg.role === "user" || msg.role === "assistant") {
      if (typeof msg.content === "string") {
        if (msg.content === "") continue;
        history.push({ role: msg.role, content: msg.content });
      } else {
        if (msg.content.length === 0) continue;
        history.push({ role: msg.role, content: toBackendContent(msg.content) });
      }
    }
  }
  return history;
}

/** 后端 PendingToolCall → 前端 PendingToolCall */
function toPendingToolCall(tool: {
  tool_call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  description?: string | null;
}): PendingToolCall {
  return {
    toolCallId: tool.tool_call_id,
    name: tool.name,
    arguments: tool.arguments,
    description: tool.description ?? undefined,
  };
}

/** 后端 ToolCallResult → 前端 ChatToolCallRecord */
export function mapToolCallResults(
  results: BackendToolCallResult[],
): ChatToolCallRecord[] {
  return results.map((r) => ({
    id: r.id,
    name: r.name,
    arguments: r.arguments ?? undefined,
    result: r.result,
  }));
}

export interface MappedChatResponse {
  conversationId: string;
  reply: string;
  needApproval: boolean;
  /** needApproval=true 时必填（后端返回 taskid） */
  taskid?: string;
  /** needApproval=true 时的待审批工具列表 */
  pendingTools: PendingToolCall[];
  /** 本次实际执行的工具调用（普通回复分支） */
  toolCalls: ChatToolCallRecord[];
  /** 本次回复的 Token 使用量 */
  usage: ChatUsage;
}

/** 后端 ChatResponse → 前端可消费的映射结果 */
export function mapChatResponse(resp: BackendChatResponse): MappedChatResponse {
  const needApproval = resp.need_approval === true;
  if (needApproval && (resp.taskid == null || resp.taskid === "")) {
    throw new Error(
      "ChatResponse 异常：need_approval=true 但缺少 taskid（请检查 fastapi-chat-service 版本）",
    );
  }
  return {
    conversationId: resp.conversation_id,
    reply: resp.reply ?? "",
    needApproval,
    taskid: needApproval ? (resp.taskid as string) : undefined,
    pendingTools: needApproval
      ? (resp.pending_tools ?? []).map(toPendingToolCall)
      : [],
    toolCalls: mapToolCallResults(resp.tool_calls ?? []),
    usage: {
      promptTokens: resp.usage?.prompt_tokens ?? 0,
      completionTokens: resp.usage?.completion_tokens ?? 0,
      totalTokens: resp.usage?.total_tokens ?? 0,
    },
  };
}

/** SSE approval 事件 → 前端 PendingAction（挂到 assistant 消息并持久化） */
export function mapApprovalEvent(
  event: BackendStreamApprovalEvent,
): PendingAction {
  return {
    taskid: event.taskid,
    tools: event.pending_tools.map(toPendingToolCall),
    createdAt: Date.now(),
    resolved: false,
  };
}
