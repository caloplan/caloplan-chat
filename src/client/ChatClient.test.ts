import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ChatClient } from "./ChatClient.js";
import type {
  ChatClientOptions,
  ChatSendResult,
  ChatStreamEvent,
} from "./ChatClient.js";
import { CHAT_SESSIONS_CACHE_KEY } from "../history/ChatHistory.js";
import type { ChatCacheLike } from "../history/ChatHistory.js";
import { ChatError, isChatError } from "../errors/ChatError.js";
import type { ChatMessage } from "../models/ChatMessage.js";
import type {
  BackendApprovalResponse,
  BackendChatResponse,
  BackendStreamEvent,
} from "../transport/types.js";

/* ── 测试工具 ── */

/** 迷你 cache（复刻 caloplan-cache 语义） */
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

/** fetch stub：捕获调用，交给 handler 决定响应 */
type FetchCall = { url: string; init: RequestInit };
function makeFetch(handler: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call.url, call.init);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/* ── SSE 响应构造 ── */

function sseFrame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** 以 SSE 流形式返回若干事件帧 */
function sseResponse(events: unknown[]): Response {
  return new Response(events.map(sseFrame).join(""), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errJson(status: number, detail: string): Response {
  return new Response(JSON.stringify({ detail }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function chatResponse(
  overrides: Partial<BackendChatResponse> = {},
): BackendChatResponse {
  return {
    conversation_id: "conv-1",
    reply: "这是回复",
    model: "deepseek-chat",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    latency_ms: 100.0,
    tool_calls: [],
    need_approval: false,
    taskid: null,
    pending_tools: [],
    ...overrides,
  };
}

function doneEvent(
  overrides: Partial<BackendChatResponse> = {},
): BackendStreamEvent {
  return { type: "done", ...chatResponse(overrides) } as BackendStreamEvent;
}

function approvalResponse(
  overrides: Partial<BackendApprovalResponse> = {},
): BackendApprovalResponse {
  return {
    conversation_id: "conv-1",
    reply: "已记录今天的午餐",
    model: "deepseek-chat",
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    latency_ms: 100.0,
    approved: true,
    tool_results: [],
    ...overrides,
  };
}

function makeClient(options: {
  handler: (url: string, init: RequestInit) => Promise<Response>;
  token?: string | null;
}): {
  client: ChatClient;
  calls: FetchCall[];
  data: Map<string, string>;
} {
  const { cache, data } = makeCache();
  const { fetchImpl, calls } = makeFetch(options.handler);
  const client = new ChatClient({
    baseURL: "http://chat.test",
    tokenProvider: () =>
      options.token === undefined ? "jwt-token" : options.token,
    cache,
    fetchImpl,
  } satisfies ChatClientOptions);
  return { client, calls, data };
}

function storedSessions(data: Map<string, string>): unknown[] {
  const raw = data.get(CHAT_SESSIONS_CACHE_KEY);
  assert.ok(raw != null, "聊天记录应已写入 cache");
  return JSON.parse(raw) as unknown[];
}

function userMsg(id: string, content: string): ChatMessage {
  return { id, role: "user", content, status: "completed", createdAt: 1 };
}

function assistantMsg(id: string, content: string): ChatMessage {
  return { id, role: "assistant", content, status: "completed", createdAt: 2 };
}

function assertChatErrorKind(err: unknown, kind: string): void {
  assert.ok(isChatError(err), `应抛出 ChatError，实际: ${String(err)}`);
  assert.equal((err as ChatError).kind, kind);
}

/** 收集整个流的事件；流内错误会 reject */
async function collect(
  stream: AsyncIterable<ChatStreamEvent>,
): Promise<ChatStreamEvent[]> {
  const events: ChatStreamEvent[] = [];
  for await (const ev of stream) events.push(ev);
  return events;
}

/** 收集流并取出 done.result；无 done 事件则断言失败 */
async function collectResult(
  stream: AsyncIterable<ChatStreamEvent>,
): Promise<ChatSendResult> {
  const events = await collect(stream);
  const done = events.find((e) => e.type === "done");
  assert.ok(done != null && done.type === "done", "应产出 done 事件");
  return done.result;
}

/* ── 发送消息：流式正常路径 ── */

describe("ChatClient.sendMessage · 流式正常路径", () => {
  test("text 增量 + done：事件序列、消息状态与 cache 持久化", async () => {
    const { client, calls, data } = makeClient({
      handler: async () =>
        sseResponse([
          { type: "text", content: "你" },
          { type: "text", content: "好" },
          doneEvent({ reply: "你好！" }),
        ]),
    });
    const session = await client.sessions.create();

    const events = await collect(client.sendMessage(session.id, "你好"));

    assert.deepEqual(
      events.map((e) => e.type),
      ["text_delta", "text_delta", "done"],
    );
    const result = (events[2] as { type: "done"; result: ChatSendResult })
      .result;
    assert.equal(result.userMessage.content, "你好");
    assert.equal(result.assistantMessage.content, "你好！");
    assert.equal(result.assistantMessage.status, "completed");
    assert.equal(result.needApproval, false);
    assert.equal(result.conversationId, "conv-1");
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /\/api\/v1\/ai\/chat$/);

    // 持久化：两条消息均在 cache（LocalStorage）中，assistant 最终为 completed
    const stored = storedSessions(data)[0] as {
      messages: Array<{ role: string; content: string; status: string }>;
      title: string;
    };
    assert.equal(stored.messages.length, 2);
    assert.equal(stored.messages[0]?.content, "你好");
    assert.equal(stored.messages[1]?.content, "你好！");
    assert.equal(stored.messages[1]?.status, "completed");
    assert.equal(stored.title, "你好");
  });

  test("请求体：stream=true，message 为本条消息，history 只含此前已完成非空消息", async () => {
    let captured: FetchCall | null = null;
    const { client } = makeClient({
      handler: async (url, init) => {
        captured = { url, init };
        return sseResponse([doneEvent()]);
      },
    });
    const session = await client.sessions.create();
    await client.sessions.appendMessage(session.id, userMsg("m1", "第一问"));
    await client.sessions.appendMessage(session.id, assistantMsg("m2", "第一答"));
    await client.sessions.appendMessage(session.id, {
      ...assistantMsg("m3", ""),
      status: "pending",
    });

    await collectResult(client.sendMessage(session.id, "第二问"));

    const body = JSON.parse(captured!.init.body as string) as {
      message: string;
      conversation_id: string;
      stream: boolean;
      history: Array<{ role: string; content: string }>;
    };
    assert.equal(body.message, "第二问");
    assert.equal(body.conversation_id, session.id);
    assert.equal(body.stream, true);
    // 本条消息不进 history；pending / 空 content 消息也不进
    assert.deepEqual(body.history, [
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
    ]);
    const headers = captured!.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer jwt-token");
    assert.equal(headers["Content-Type"], "application/json");
  });

  test("流式过程中 content 实时累积，且每个增量都同步写回 cache", async () => {
    const { client, data } = makeClient({
      handler: async () =>
        sseResponse([
          { type: "text", content: "你" },
          { type: "text", content: "好" },
          { type: "text", content: "！" },
          doneEvent({ reply: "你好！" }),
        ]),
    });
    const session = await client.sessions.create();

    const seen: Array<{ content: string; status: string }> = [];
    for await (const ev of client.sendMessage(session.id, "你好")) {
      if (ev.type === "text_delta") {
        // SDK 保证 assistant 流式消息 content 恒为字符串（增量累积 / done.reply）
        const content = ev.assistantMessage.content;
        if (typeof content !== "string") {
          throw new Error("assistant 流式消息 content 应为字符串");
        }
        seen.push({
          content,
          status: ev.assistantMessage.status,
        });
        // 实时性：当前增量已同步到 cache（LocalStorage）
        const stored = storedSessions(data)[0] as {
          messages: Array<{ content: string; status: string }>;
        };
        assert.equal(stored.messages[1]?.content, ev.assistantMessage.content);
        assert.equal(stored.messages[1]?.status, "streaming");
      }
    }

    assert.deepEqual(seen, [
      { content: "你", status: "streaming" },
      { content: "你好", status: "streaming" },
      { content: "你好！", status: "streaming" },
    ]);
    // done 后最终落盘为 completed
    const stored = storedSessions(data)[0] as {
      messages: Array<{ content: string; status: string }>;
    };
    assert.equal(stored.messages[1]?.content, "你好！");
    assert.equal(stored.messages[1]?.status, "completed");
  });

  test("空消息 / 不存在的会话：直接抛错，不发起请求", async () => {
    const { client, calls } = makeClient({
      handler: async () => sseResponse([doneEvent()]),
    });
    const session = await client.sessions.create();

    await assert.rejects(
      () => collect(client.sendMessage(session.id, "   ")),
      /不能为空/,
    );
    await assert.rejects(
      () => collect(client.sendMessage("missing", "你好")),
      /会话不存在/,
    );
    assert.equal(calls.length, 0);
  });
});

/* ── 发送消息：多模态内容块（对齐后端 ChatRequest.message: str | list[ContentBlock]）── */

describe("ChatClient.sendMessage · 多模态内容块", () => {
  test("内容块数组：body.message 转为 wire 结构（imageUrl → image_url），user 消息原样落盘", async () => {
    let captured: FetchCall | null = null;
    const { client, data } = makeClient({
      handler: async (url, init) => {
        captured = { url, init };
        return sseResponse([doneEvent({ reply: "已收到图片" })]);
      },
    });
    const session = await client.sessions.create();

    const result = await collectResult(
      client.sendMessage(session.id, [
        { type: "text", text: "看下这张餐食" },
        {
          type: "image_url",
          imageUrl: "data:image/jpeg;base64,/9j/4AAQ",
        },
      ]),
    );

    const body = JSON.parse(captured!.init.body as string) as {
      message: Array<{ type: string; text?: string; image_url?: string }>;
      stream: boolean;
    };
    assert.deepEqual(body.message, [
      { type: "text", text: "看下这张餐食" },
      { type: "image_url", image_url: "data:image/jpeg;base64,/9j/4AAQ" },
    ]);
    assert.equal(body.stream, true);
    // user 消息以内容块数组持久化（刷新后图片消息不丢失）
    assert.deepEqual(result.userMessage.content, [
      { type: "text", text: "看下这张餐食" },
      { type: "image_url", imageUrl: "data:image/jpeg;base64,/9j/4AAQ" },
    ]);
    const stored = storedSessions(data)[0] as {
      messages: Array<{ role: string; content: unknown }>;
    };
    assert.equal(stored.messages[0]?.role, "user");
    assert.deepEqual(stored.messages[0]?.content, [
      { type: "text", text: "看下这张餐食" },
      { type: "image_url", imageUrl: "data:image/jpeg;base64,/9j/4AAQ" },
    ]);
  });

  test("历史中的内容块 user 消息：toBackendHistory 转为 wire 结构回传，空数组跳过", async () => {
    let captured: FetchCall | null = null;
    const { client } = makeClient({
      handler: async (url, init) => {
        captured = { url, init };
        return sseResponse([doneEvent()]);
      },
    });
    const session = await client.sessions.create();
    await client.sessions.appendMessage(session.id, {
      id: "m-img",
      role: "user",
      content: [
        { type: "text", text: "看下这张" },
        { type: "image_url", imageUrl: { url: "https://cdn.test/a.jpg" } },
      ],
      status: "completed",
      createdAt: 1,
    });
    await client.sessions.appendMessage(session.id, {
      id: "m-empty",
      role: "user",
      content: [],
      status: "completed",
      createdAt: 2,
    });

    await collectResult(client.sendMessage(session.id, "第二问"));

    const body = JSON.parse(captured!.init.body as string) as {
      history: Array<{ role: string; content: unknown }>;
    };
    assert.deepEqual(body.history, [
      {
        role: "user",
        content: [
          { type: "text", text: "看下这张" },
          { type: "image_url", image_url: { url: "https://cdn.test/a.jpg" } },
        ],
      },
    ]);
  });

  test("空内容块 / 全空块：直接抛错，不发起请求", async () => {
    const { client, calls } = makeClient({
      handler: async () => sseResponse([doneEvent()]),
    });
    const session = await client.sessions.create();

    await assert.rejects(
      () => collect(client.sendMessage(session.id, [])),
      /不能为空/,
    );
    await assert.rejects(
      () => collect(client.sendMessage(session.id, [{ type: "text", text: "  " }])),
      /不能为空/,
    );
    await assert.rejects(
      () =>
        collect(
          client.sendMessage(session.id, [
            { type: "image_url", imageUrl: "" },
          ]),
        ),
      /不能为空/,
    );
    assert.equal(calls.length, 0);
  });
});

/* ── 发送消息：失败处理 ── */

describe("ChatClient.sendMessage · 失败处理", () => {
  test("后端 HTTP 500：用户消息与历史不丢，assistant 标记 failed，抛 kind=backend", async () => {
    const { client, data } = makeClient({
      handler: async () => errJson(500, "AI 调用失败: boom"),
    });
    const session = await client.sessions.create();

    await assert.rejects(
      () => collect(client.sendMessage(session.id, "你好")),
      (err: unknown) => {
        assertChatErrorKind(err, "backend");
        assert.match((err as ChatError).message, /AI 调用失败/);
        assert.equal((err as ChatError).status, 500);
        return true;
      },
    );

    const stored = storedSessions(data)[0] as {
      messages: Array<{ role: string; content: string; status: string }>;
    };
    assert.equal(stored.messages.length, 2);
    assert.equal(stored.messages[0]?.role, "user");
    assert.equal(stored.messages[0]?.status, "completed");
    assert.equal(stored.messages[1]?.role, "assistant");
    assert.equal(stored.messages[1]?.status, "failed");
  });

  test("网络失败：fetch 抛错 → kind=network，用户消息已持久化", async () => {
    const { client, data } = makeClient({
      handler: async () => {
        throw new TypeError("fetch failed");
      },
    });
    const session = await client.sessions.create();

    await assert.rejects(
      () => collect(client.sendMessage(session.id, "你好")),
      (err: unknown) => {
        assertChatErrorKind(err, "network");
        return true;
      },
    );

    const stored = storedSessions(data)[0] as {
      messages: Array<{ role: string; status: string }>;
    };
    assert.equal(stored.messages[0]?.role, "user");
    assert.equal(stored.messages[0]?.status, "completed");
    assert.equal(stored.messages[1]?.status, "failed");
  });

  test("401 → kind=auth", async () => {
    const { client } = makeClient({
      handler: async () => errJson(401, "无法验证凭据"),
    });
    const session = await client.sessions.create();
    await assert.rejects(
      () => collect(client.sendMessage(session.id, "你好")),
      (err: unknown) => {
        assertChatErrorKind(err, "auth");
        return true;
      },
    );
  });

  test("tokenProvider 返回空 → kind=auth，且不发起请求", async () => {
    const { client, calls } = makeClient({
      token: null,
      handler: async () => sseResponse([doneEvent()]),
    });
    const session = await client.sessions.create();

    await assert.rejects(
      () => collect(client.sendMessage(session.id, "你好")),
      (err: unknown) => {
        assertChatErrorKind(err, "auth");
        return true;
      },
    );
    assert.equal(calls.length, 0);
  });

  test("SSE error 事件（HTTP 200）→ kind=stream，已收增量保留，assistant 置 failed", async () => {
    const { client, data } = makeClient({
      handler: async () =>
        sseResponse([
          { type: "text", content: "部分" },
          { type: "error", detail: "AI 调用失败: boom" },
        ]),
    });
    const session = await client.sessions.create();

    await assert.rejects(
      () => collect(client.sendMessage(session.id, "你好")),
      (err: unknown) => {
        assertChatErrorKind(err, "stream");
        assert.match((err as ChatError).message, /boom/);
        return true;
      },
    );

    const stored = storedSessions(data)[0] as {
      messages: Array<{ role: string; content: string; status: string }>;
    };
    // 用户消息不丢；assistant 保留已收内容并标记 failed
    assert.equal(stored.messages[0]?.status, "completed");
    assert.equal(stored.messages[1]?.content, "部分");
    assert.equal(stored.messages[1]?.status, "failed");
  });

  test("SSE 未知事件类型 → kind=stream", async () => {
    const { client } = makeClient({
      handler: async () =>
        new Response('data: {"type":"mystery","x":1}\n\n', {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
    });
    const session = await client.sessions.create();
    await assert.rejects(
      () => collect(client.sendMessage(session.id, "你好")),
      (err: unknown) => {
        assertChatErrorKind(err, "stream");
        return true;
      },
    );
  });

  test("200 但响应不是合法 SSE → kind=stream", async () => {
    const { client } = makeClient({
      handler: async () => new Response("not json", { status: 200 }),
    });
    const session = await client.sessions.create();
    await assert.rejects(
      () => collect(client.sendMessage(session.id, "你好")),
      (err: unknown) => {
        assertChatErrorKind(err, "stream");
        return true;
      },
    );
  });
});

/* ── Pending Action / 审批（流式） ── */

describe("ChatClient · Pending Action / 审批（流式）", () => {
  function approvalStreamHandler(): (
    url: string,
    init: RequestInit,
  ) => Promise<Response> {
    return async (url) => {
      if (url.endsWith("/api/v1/ai/chat")) {
        return sseResponse([
          {
            type: "approval",
            taskid: "task-9f2c",
            pending_tools: [
              {
                tool_call_id: "call-1",
                name: "create_meal",
                arguments: { meal_type: "lunch" },
                description: "执行需要用户确认",
              },
            ],
          },
          doneEvent({
            need_approval: true,
            taskid: "task-9f2c",
            pending_tools: [
              {
                tool_call_id: "call-1",
                name: "create_meal",
                arguments: { meal_type: "lunch" },
                description: "执行需要用户确认",
              },
            ],
          }),
        ]);
      }
      return okJson(approvalResponse());
    };
  }

  test("approval 事件：pendingAction 挂载并持久化，随后 done（审批分支）", async () => {
    const { client, data } = makeClient({
      handler: approvalStreamHandler(),
    });
    const session = await client.sessions.create();

    const events = await collect(client.sendMessage(session.id, "记录今天午餐"));

    assert.deepEqual(
      events.map((e) => e.type),
      ["approval", "done"],
    );
    const approval = events[0] as {
      type: "approval";
      pendingAction: { taskid: string; tools: Array<{ name: string }>; resolved: boolean };
    };
    assert.equal(approval.pendingAction.taskid, "task-9f2c");
    assert.equal(approval.pendingAction.tools[0]?.name, "create_meal");
    assert.equal(approval.pendingAction.resolved, false);

    const done = events[1] as { type: "done"; result: ChatSendResult };
    assert.equal(done.result.needApproval, true);
    assert.equal(done.result.assistantMessage.content, "");
    assert.equal(done.result.assistantMessage.status, "completed");
    assert.equal(
      done.result.assistantMessage.pendingAction?.taskid,
      "task-9f2c",
    );

    const stored = storedSessions(data)[0] as {
      messages: Array<{
        pendingAction: { taskid: string; resolved: boolean };
        status: string;
      }>;
    };
    assert.equal(stored.messages[1]?.pendingAction.taskid, "task-9f2c");
    assert.equal(stored.messages[1]?.pendingAction.resolved, false);
    assert.equal(stored.messages[1]?.status, "completed");
  });

  test("confirm(taskid)：请求体 {taskid, approved:true}，pendingAction 置 resolved，追加最终回复", async () => {
    const { client, calls, data } = makeClient({
      handler: async (url) => {
        if (url.endsWith("/api/v1/ai/chat")) {
          return sseResponse([
            {
              type: "approval",
              taskid: "task-1",
              pending_tools: [
                {
                  tool_call_id: "call-1",
                  name: "create_meal",
                  arguments: {},
                  description: null,
                },
              ],
            },
            doneEvent({
              need_approval: true,
              taskid: "task-1",
              pending_tools: [
                {
                  tool_call_id: "call-1",
                  name: "create_meal",
                  arguments: {},
                  description: null,
                },
              ],
            }),
          ]);
        }
        return okJson(
          approvalResponse({
            approved: true,
            reply: "已记录今天的午餐",
            tool_results: [
              { id: "call-1", name: "create_meal", result: { ok: true } },
            ],
          }),
        );
      },
    });
    const session = await client.sessions.create();
    await collectResult(client.sendMessage(session.id, "记录今天午餐"));

    const result = await client.confirm("task-1");

    assert.equal(result.approved, true);
    assert.equal(result.reply, "已记录今天的午餐");
    assert.equal(result.toolResults.length, 1);
    assert.equal(result.toolResults[0]?.name, "create_meal");

    const approvalCall = calls.find(
      (c) => c.url.endsWith("/api/v1/ai/approval"),
    );
    assert.ok(approvalCall != null);
    assert.deepEqual(JSON.parse(approvalCall.init.body as string), {
      taskid: "task-1",
      approved: true,
    });

    // 本地历史：审批卡片 resolved + 最终回复追加为第三条消息
    assert.equal(session.messages.length, 3);
    assert.equal(session.messages[1]?.pendingAction?.resolved, true);
    assert.equal(session.messages[1]?.pendingAction?.outcome, "approved");
    assert.equal(session.messages[2]?.content, "已记录今天的午餐");
    const stored = storedSessions(data)[0] as {
      messages: Array<{
        pendingAction?: { resolved: boolean };
        content: string;
      }>;
    };
    assert.equal(stored.messages[1]?.pendingAction?.resolved, true);
    assert.equal(stored.messages[2]?.content, "已记录今天的午餐");
  });

  test("cancel(taskid)：请求体 {taskid, approved:false}，outcome=cancelled", async () => {
    const { client, calls } = makeClient({
      handler: async (url) => {
        if (url.endsWith("/api/v1/ai/chat")) {
          return sseResponse([
            { type: "approval", taskid: "task-2", pending_tools: [] },
            doneEvent({
              need_approval: true,
              taskid: "task-2",
              pending_tools: [],
            }),
          ]);
        }
        return okJson(
          approvalResponse({ approved: false, reply: "好的，不记录了" }),
        );
      },
    });
    const session = await client.sessions.create();
    await collectResult(client.sendMessage(session.id, "记录今天午餐"));

    const result = await client.cancel("task-2");

    assert.equal(result.approved, false);
    assert.equal(result.reply, "好的，不记录了");
    const approvalCall = calls.find(
      (c) => c.url.endsWith("/api/v1/ai/approval"),
    );
    assert.deepEqual(JSON.parse(approvalCall!.init.body as string), {
      taskid: "task-2",
      approved: false,
    });
    assert.equal(session.messages[1]?.pendingAction?.outcome, "cancelled");
    assert.equal(session.messages[1]?.pendingAction?.resolved, true);
    assert.equal(session.messages[2]?.content, "好的，不记录了");
  });

  test("审批过期（410）→ kind=confirmation，pendingAction 保持未解决，历史不丢", async () => {
    const { client } = makeClient({
      handler: async (url) => {
        if (url.endsWith("/api/v1/ai/chat")) {
          return sseResponse([
            { type: "approval", taskid: "task-old", pending_tools: [] },
            doneEvent({
              need_approval: true,
              taskid: "task-old",
              pending_tools: [],
            }),
          ]);
        }
        return errJson(410, "审批任务不存在或已过期");
      },
    });
    const session = await client.sessions.create();
    await collectResult(client.sendMessage(session.id, "记录今天午餐"));

    await assert.rejects(
      () => client.confirm("task-old"),
      (err: unknown) => {
        assertChatErrorKind(err, "confirmation");
        assert.equal((err as ChatError).status, 410);
        return true;
      },
    );
    assert.equal(session.messages[1]?.pendingAction?.resolved, false);
  });

  test("审批越权（403）→ kind=confirmation", async () => {
    const { client } = makeClient({
      handler: async (url) => {
        if (url.endsWith("/api/v1/ai/chat")) {
          return sseResponse([
            { type: "approval", taskid: "task-3", pending_tools: [] },
            doneEvent({
              need_approval: true,
              taskid: "task-3",
              pending_tools: [],
            }),
          ]);
        }
        return errJson(403, "无权执行该审批任务");
      },
    });
    const session = await client.sessions.create();
    await collectResult(client.sendMessage(session.id, "记录今天午餐"));
    await assert.rejects(
      () => client.confirm("task-3"),
      (err: unknown) => {
        assertChatErrorKind(err, "confirmation");
        return true;
      },
    );
  });
});

/* ── 消息更新 / 页面刷新 ── */

describe("ChatClient · 消息更新与页面刷新恢复", () => {
  test("sessions.updateMessage 局部更新并持久化", async () => {
    const { client, data } = makeClient({
      handler: async () => sseResponse([doneEvent()]),
    });
    const session = await client.sessions.create();
    await client.sessions.appendMessage(session.id, {
      id: "m-1",
      role: "assistant",
      content: "",
      status: "pending",
      createdAt: 1,
    });

    const updated = await client.sessions.updateMessage(session.id, "m-1", {
      content: "部分内容",
      status: "completed",
    });

    assert.equal(updated?.content, "部分内容");
    assert.equal(updated?.status, "completed");
    const stored = storedSessions(data)[0] as {
      messages: Array<{ content: string; status: string }>;
    };
    assert.equal(stored.messages[0]?.content, "部分内容");
    assert.equal(stored.messages[0]?.status, "completed");
  });

  test("页面刷新：同 storage 新建 ChatClient，init() 后恢复会话与消息", async () => {
    const { cache, data } = makeCache();
    const { fetchImpl, calls } = makeFetch(async () =>
      sseResponse([doneEvent({ reply: "你好！" })]),
    );
    const client1 = new ChatClient({
      baseURL: "http://chat.test",
      tokenProvider: () => "jwt",
      cache,
      fetchImpl,
    });
    const session = await client1.sessions.create();
    await collectResult(client1.sendMessage(session.id, "你好"));
    assert.equal(calls.length, 1);

    // 模拟页面刷新：同一底层 storage 上重建实例
    const client2 = new ChatClient({
      baseURL: "http://chat.test",
      tokenProvider: () => "jwt",
      cache,
      fetchImpl: makeFetch(async () => sseResponse([doneEvent()])).fetchImpl,
    });
    await client2.init();

    const restored = client2.sessions.get(session.id);
    assert.ok(restored != null);
    assert.equal(restored.messages.length, 2);
    assert.equal(restored.messages[0]?.content, "你好");
    assert.equal(restored.messages[0]?.status, "completed");
    assert.equal(restored.messages[1]?.content, "你好！");
    assert.equal(restored.messages[1]?.status, "completed");
    assert.ok(data.has(CHAT_SESSIONS_CACHE_KEY));
  });

  test("清空会话后消息从 cache 移除，会话保留", async () => {
    const { client, data } = makeClient({
      handler: async () => sseResponse([doneEvent()]),
    });
    const session = await client.sessions.create();
    await collectResult(client.sendMessage(session.id, "你好"));

    await client.sessions.clear(session.id);

    const stored = storedSessions(data)[0] as { messages: unknown[] };
    assert.deepEqual(stored.messages, []);
    assert.ok(client.sessions.get(session.id) != null);
  });

  test("删除会话后从 cache 移除", async () => {
    const { client, data } = makeClient({
      handler: async () => sseResponse([doneEvent()]),
    });
    const session = await client.sessions.create();

    await client.sessions.delete(session.id);

    assert.equal(client.sessions.get(session.id), null);
    assert.equal(storedSessions(data).length, 0);
  });
});
