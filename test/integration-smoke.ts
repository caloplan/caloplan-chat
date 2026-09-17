/* 一次性集成冒烟验证：真实 caloplan-cache Cache 实例 ↔ caloplan-chat（用完可删） */
import { Cache } from "../caloplan-cache/dist/index.js";
import { ChatClient } from "./src/client/ChatClient.ts";

const store = new Map<string, string>();
const storage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    store.set(k, v);
  },
  removeItem: (k: string) => {
    store.delete(k);
  },
};

const cache = new Cache(storage);
const chat = new ChatClient({
  baseURL: "http://localhost:9095",
  tokenProvider: () => "test-jwt",
  cache,
});

const session = await chat.sessions.create({ title: "集成验证" });
await chat.sessions.appendMessage(session.id, {
  id: "m1",
  role: "user",
  content: "你好",
  status: "completed",
  createdAt: Date.now(),
});
console.log("localStorage raw:", store.get("chat_sessions"));

const chat2 = new ChatClient({
  baseURL: "http://localhost:9095",
  tokenProvider: () => "test-jwt",
  cache: new Cache(storage),
});
await chat2.init();
const restored = chat2.sessions.get(session.id);
console.log(
  "restored title:",
  restored?.title,
  "| messages:",
  restored?.messages.length,
);
console.log("integration OK:", restored?.messages[0]?.content === "你好");
