import { ChatClient } from "./client/ChatClient.js";
import type { ChatClientOptions } from "./client/ChatClient.js";

let instance: ChatClient | null = null;

/**
 * 初始化 caloplan-chat 单例（与 createCPCache / createCPCore / createCPUser 风格一致）。
 * - baseURL：fastapi-chat-service 地址
 * - tokenProvider：外部注入的 Token 提供器（登录 / 刷新由上层负责）
 * - cache：已初始化的 caloplan-cache 实例（或兼容契约的缓存实现）
 */
export function createCPChat(options: ChatClientOptions): ChatClient {
  instance = new ChatClient(options);
  return instance;
}

/** 获取 caloplan-chat 单例：chat.sessions / chat.sendMessage / chat.confirm / chat.cancel */
export function getCPChat(): ChatClient {
  if (instance == null) {
    throw new Error("CPChat 未初始化：请先调用 createCPChat()");
  }
  return instance;
}
