import type { ChatMessage } from "./ChatMessage.js";

/**
 * 前端聊天会话（本地聊天记录的组织单位）。
 *
 * 后端 fastapi-chat-service 为**无状态**对话（历史由客户端全量回传，无 session 概念，
 * `conversation_id` 仅日志关联 / 幂等用），因此本会话是纯前端概念：
 * - 会话 ID（`id`）由本 SDK 生成（nanoid），同时作为 `conversation_id` 传给后端；
 * - 后端上下文组织（若有）与前端会话组织不冲突，无需维护两套 ID。
 */
export interface ChatSession {
  id: string;
  /** 会话标题；创建时可为空，写入第一条 user 消息时自动生成 */
  title: string;
  messages: ChatMessage[];
  /** 创建时间（epoch ms） */
  createdAt: number;
  /** 最后变更时间（epoch ms） */
  updatedAt: number;
}
