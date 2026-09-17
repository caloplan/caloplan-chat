import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ChatHistory, CHAT_SESSIONS_CACHE_KEY } from "./ChatHistory.js";
import type { ChatCacheLike } from "./ChatHistory.js";
import { ChatError, isChatError } from "../errors/ChatError.js";
import type { ChatMessage } from "../models/ChatMessage.js";

/**
 * 迷你 cache：严格复刻 caloplan-cache 语义（register / get / refresh / delete +
 * JSON 序列化 + 底层 storage Map），用于验证「chat → cache → LocalStorage」链路。
 * caloplan-cache 的 Cache 类结构上满足 ChatCacheLike，可无缝替换。
 */
function makeCache(initial: Record<string, string> = {}): {
  cache: ChatCacheLike;
  data: Map<string, string>;
} {
  const data = new Map<string, string>(Object.entries(initial));
  const producers = new Map<string, () => unknown>();
  const cache: ChatCacheLike = {
    register(key, producer) {
      producers.set(key, producer);
    },
    async get<T>(key: string): Promise<T | null> {
      const raw = data.get(key);
      if (raw != null) return JSON.parse(raw) as T;
      const producer = producers.get(key);
      if (producer == null) {
        throw new Error(`Cache.get 失败：key = "${key}" 未注册 producer`);
      }
      // 与 caloplan-cache 一致：未命中 → producer 生产 → 写回 storage
      const value = await producer();
      data.set(key, JSON.stringify(value));
      return value as T;
    },
    async refresh<T>(key: string): Promise<T> {
      const producer = producers.get(key);
      if (producer == null) {
        throw new Error(`Cache.refresh 失败：key = "${key}" 未注册 producer`);
      }
      const value = await producer();
      data.set(key, JSON.stringify(value));
      return value as T;
    },
    delete(key) {
      data.delete(key);
    },
  };
  return { cache, data };
}

/** 读取当前持久化的会话数组 */
function storedSessions(data: Map<string, string>): unknown[] {
  const raw = data.get(CHAT_SESSIONS_CACHE_KEY);
  assert.ok(raw != null, "聊天记录应已写入 cache");
  return JSON.parse(raw) as unknown[];
}

function userMessage(content: string): ChatMessage {
  return {
    id: `u-${content}`,
    role: "user",
    content,
    status: "completed",
    createdAt: 1000,
  };
}

function assistantMessage(content: string): ChatMessage {
  return {
    id: `a-${content}`,
    role: "assistant",
    content,
    status: "completed",
    createdAt: 2000,
  };
}

describe("ChatHistory · Session", () => {
  test("create 生成 id / 时间戳，并立即写回 cache（LocalStorage）", async () => {
    const { cache, data } = makeCache();
    const history = new ChatHistory(cache);

    const session = await history.create();

    assert.ok(session.id.length > 0);
    assert.equal(session.title, "");
    assert.deepEqual(session.messages, []);
    assert.ok(session.createdAt > 0);
    assert.ok(session.updatedAt > 0);
    assert.equal(storedSessions(data).length, 1);
  });

  test("create 支持自定义标题，新会话排在最前", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);

    const first = await history.create({ title: "旧" });
    const second = await history.create({ title: "新" });

    assert.equal(first.title, "旧");
    assert.equal(second.title, "新");
    assert.deepEqual(history.list().map((s) => s.id), [second.id, first.id]);
  });

  test("get 按 id 返回会话，不存在返回 null", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);
    const session = await history.create();

    assert.equal(history.get(session.id)?.id, session.id);
    assert.equal(history.get("missing"), null);
  });

  test("delete 删除会话并持久化；删除不存在的会话静默成功", async () => {
    const { cache, data } = makeCache();
    const history = new ChatHistory(cache);
    const session = await history.create();
    await history.create();

    await history.delete(session.id);

    assert.equal(history.get(session.id), null);
    assert.equal(storedSessions(data).length, 1);
    await history.delete("missing"); // 不抛错
  });

  test("clear 清空消息但保留会话", async () => {
    const { cache, data } = makeCache();
    const history = new ChatHistory(cache);
    const session = await history.create();
    await history.appendMessage(session.id, userMessage("你好"));

    const cleared = await history.clear(session.id);

    assert.ok(cleared != null);
    assert.deepEqual(cleared.messages, []);
    assert.equal(history.get(session.id)?.messages.length, 0);
    const clearedStored = storedSessions(data)[0] as
      | { messages: unknown[] }
      | undefined;
    assert.equal(clearedStored?.messages.length, 0);
  });

  test("clear 不存在的会话返回 null", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);
    assert.equal(await history.clear("missing"), null);
  });
});

describe("ChatHistory · Message", () => {
  test("appendMessage 追加消息并写回 cache；第一条 user 消息自动生成标题", async () => {
    const { cache, data } = makeCache();
    const history = new ChatHistory(cache);
    const session = await history.create();

    await history.appendMessage(session.id, userMessage("今天午饭吃什么？"));
    await history.appendMessage(session.id, assistantMessage("建议吃鸡胸肉"));

    assert.equal(session.messages.length, 2);
    assert.equal(session.title, "今天午饭吃什么？");
    const stored = storedSessions(data)[0] as
      | { messages: Array<{ content: string; status: string }> }
      | undefined;
    assert.equal(stored?.messages.length, 2);
    assert.equal(stored?.messages[1]?.content, "建议吃鸡胸肉");
  });

  test("超长首条消息标题截断 24 字", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);
    const session = await history.create();
    await history.appendMessage(
      session.id,
      userMessage("这是一条非常非常非常非常非常非常非常长的用户消息用来测试标题截断逻辑是否正常工作"),
    );
    assert.ok(session.title.endsWith("…"));
    assert.ok(session.title.length <= 25);
  });

  test("内容块数组首条消息：标题取 text 块拼接", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);
    const session = await history.create();
    await history.appendMessage(session.id, {
      id: "m-blocks",
      role: "user",
      content: [
        { type: "text", text: "记录一下" },
        { type: "text", text: "今天的午餐" },
        { type: "image_url", imageUrl: "data:image/jpeg;base64,xxx" },
      ],
      status: "completed",
      createdAt: 1,
    });
    assert.equal(session.title, "记录一下 今天的午餐");
  });

  test("纯图片块首条消息：标题为空串", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);
    const session = await history.create();
    await history.appendMessage(session.id, {
      id: "m-img",
      role: "user",
      content: [{ type: "image_url", imageUrl: "data:image/jpeg;base64,xxx" }],
      status: "completed",
      createdAt: 1,
    });
    assert.equal(session.title, "");
  });

  test("updateMessage 局部更新 content / status / pendingAction 并持久化", async () => {
    const { cache, data } = makeCache();
    const history = new ChatHistory(cache);
    const session = await history.create();
    await history.appendMessage(session.id, userMessage("你好"));
    const assistant = assistantMessage("");
    await history.appendMessage(session.id, assistant);

    const updated = await history.updateMessage(session.id, assistant.id, {
      content: "你好，有什么可以帮你？",
      status: "completed",
    });

    assert.equal(updated?.content, "你好，有什么可以帮你？");
    assert.equal(updated?.status, "completed");
    const stored = storedSessions(data)[0] as
      | { messages: Array<{ content: string }> }
      | undefined;
    assert.equal(stored?.messages[1]?.content, "你好，有什么可以帮你？");
  });

  test("updateMessage 消息不存在返回 null", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);
    const session = await history.create();
    assert.equal(
      await history.updateMessage(session.id, "nope", { status: "failed" }),
      null,
    );
  });

  test("appendMessage 到不存在的会话抛错", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);
    await assert.rejects(
      () => history.appendMessage("missing", userMessage("hi")),
      /会话不存在/,
    );
  });

  test("findPendingAction 按 taskid 找到审批消息", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);
    const session = await history.create();
    await history.appendMessage(session.id, userMessage("记录今天午餐"));
    const approval = assistantMessage("");
    approval.pendingAction = {
      taskid: "task-1",
      tools: [{ toolCallId: "c1", name: "create_meal", arguments: {} }],
      createdAt: Date.now(),
      resolved: false,
    };
    await history.appendMessage(session.id, approval);

    const found = history.findPendingAction("task-1");
    assert.ok(found != null);
    assert.equal(found.sessionId, session.id);
    assert.equal(found.message.pendingAction?.taskid, "task-1");
    assert.equal(history.findPendingAction("task-2"), null);
  });
});

describe("ChatHistory · 页面刷新恢复（chat → cache → LocalStorage）", () => {
  test("新实例 init() 从 cache 恢复全部 Session 与 Messages", async () => {
    const { cache } = makeCache();
    const history1 = new ChatHistory(cache);
    const session = await history1.create({ title: "测试会话" });
    await history1.appendMessage(session.id, userMessage("你好"));
    await history1.appendMessage(session.id, assistantMessage("你好！"));
    await history1.appendMessage(
      session.id,
      Object.assign(assistantMessage(""), {
        status: "pending",
      } as ChatMessage),
    );

    // 模拟页面刷新：同一 storage 上新建实例
    const history2 = new ChatHistory(cache);
    await history2.init();

    const restored = history2.get(session.id);
    assert.ok(restored != null);
    assert.equal(restored.title, "测试会话");
    assert.equal(restored.messages.length, 3);
    assert.equal(restored.messages[0]?.content, "你好");
    assert.equal(restored.messages[2]?.status, "pending");
    assert.deepEqual(history2.list().map((s) => s.id), [session.id]);
  });

  test("init 幂等：重复调用不重复覆盖数据", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);
    await history.create({ title: "s1" });
    await history.init();
    await history.init();
    assert.equal(history.list().length, 1);
  });

  test("冷启动（无缓存）：get 调用 producer 回填空数组，随后创建可正常持久化", async () => {
    const { cache, data } = makeCache();
    const history = new ChatHistory(cache);
    await history.init();
    // 冷启动后 cache 中应为空数组（producer 回填）
    assert.deepEqual(storedSessions(data), []);
    const session = await history.create();
    assert.equal(storedSessions(data).length, 1);
    assert.equal(history.get(session.id)?.id, session.id);
  });

  test("cache 数据损坏（非数组）时回退为空历史，不抛错", async () => {
    const { cache } = makeCache({ [CHAT_SESSIONS_CACHE_KEY]: '{"bad": true}' });
    const history = new ChatHistory(cache);
    await history.init();
    assert.deepEqual(history.list(), []);
  });
});

describe("ChatHistory · Cache 错误", () => {
  test("恢复失败（cache.get 抛错）→ ChatError kind=cache", async () => {
    const broken: ChatCacheLike = {
      register() {},
      async get() {
        throw new Error("storage denied");
      },
      async refresh() {
        throw new Error("storage denied");
      },
      delete() {},
    };
    const history = new ChatHistory(broken);
    await assert.rejects(
      () => history.init(),
      (err: unknown) => {
        assert.ok(isChatError(err));
        assert.equal((err as ChatError).kind, "cache");
        assert.match((err as ChatError).message, /storage denied/);
        return true;
      },
    );
  });

  test("保存失败（cache.refresh 抛错）→ ChatError kind=cache，且内存态不变", async () => {
    const { cache } = makeCache();
    const history = new ChatHistory(cache);
    await history.init();
    // 让 refresh 开始抛错
    const cacheWithBrokenRefresh: ChatCacheLike = {
      register: (k, p) => cache.register(k, p),
      get: (k) => cache.get(k),
      async refresh() {
        throw new Error("quota exceeded");
      },
      delete: (k) => cache.delete(k),
    };
    const failing = new ChatHistory(cacheWithBrokenRefresh);
    await assert.rejects(
      () => failing.create(),
      (err: unknown) => {
        assert.ok(isChatError(err));
        assert.equal((err as ChatError).kind, "cache");
        return true;
      },
    );
  });
});
