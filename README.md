# caloplan-chat

CaloPlan 前端 Chat SDK —— 对接 **fastapi-chat-service**（SSE 流式对话），本地聊天记录经 **caloplan-cache** 缓存。
纯 TypeScript、框架无关（Vue / React / React Native / Web 通用），不直接操作 localStorage，不实现登录。
## 相关项目（CaloPlan 全家桶）

CaloPlan 全栈项目统一托管在 GitHub Organization [caloplan](https://github.com/caloplan)：

| 类型 | 项目 | 与本项目关系 |
| --- | --- | --- |
| 前端 | [coloplan-v2](https://github.com/caloplan/coloplan-v2) | 上层客户端：复用本模块的 AI 对话能力 |
| SDK | [caloplan-core](https://github.com/caloplan/caloplan-core) | 餐食 / 食物模块（兄弟 SDK） |
| SDK | [caloplan-user](https://github.com/caloplan/caloplan-user) | 用户模块（兄弟 SDK） |
| SDK（本仓库） | [caloplan-chat](https://github.com/caloplan/caloplan-chat) | AI 对话 SDK（SSE 流式） |
| SDK | [caloplan-cache](https://github.com/caloplan/caloplan-cache) | 本地聊天历史经其缓存 |
| 服务 | [fastapi-chat-service](https://github.com/caloplan/fastapi-chat-service) | AI 对话后端（本模块对接的 HTTP / SSE 服务） |
| 服务 | [fastapi-file-service](https://github.com/caloplan/fastapi-file-service) | 图片上传后端（图片识别链路） |
| 服务 | [mservice-fastapi-user](https://github.com/caloplan/mservice-fastapi-user) | 认证 / 用户微服务（Token 来源） |
| 服务 | [mservice-fastapi-metastorage](https://github.com/caloplan/mservice-fastapi-metastorage) | 元数据微服务（AI 工具写餐食 / 身体数据） |

本模块对接 `fastapi-chat-service`（SSE 流式对话），本地历史经 `caloplan-cache` 持久化。

```
CaloPlan Frontend
        │
        ├── caloplan-chat
        │       │
        │       ├── HTTP Request + SSE Streaming（fetch，Bearer Token 透传）
        │       ├── Session / Message（本地聊天记录组织）
        │       ├── Pending Action（taskid 审批流客户端交互）
        │       │
        │       └── caloplan-cache
        │               │
        │               ↓
        │          LocalStorage
        │
        ↓
fastapi-chat-service（AI Agent / Tool Call / 服务端鉴权 / 审批 / SSE 流式）
```

## 职责边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| **caloplan-chat** | 调用 fastapi-chat-service；请求 / 鉴权头 / 审批流封装；Session / Message 管理；经 caloplan-cache 管理本地记录 | UI（弹窗 / Modal / 样式）、登录 / 注册 / Token 刷新、全局状态、直接操作 localStorage |
| **caloplan-cache** | key → cached value（怎么存：JSON 序列化 + LocalStorage） | 理解 ChatSession / ChatMessage 等业务概念（存什么由 chat 决定） |
| **fastapi-chat-service** | AI Agent / Tool Call / 服务端鉴权 / Pending Action / 审批执行 | 前端历史存储（无状态，历史由客户端回传） |

## 快速开始

```bash
pnpm install
pnpm typecheck    # tsc --noEmit
pnpm test         # node:test + tsx
pnpm build        # tsc -p tsconfig.build.json → dist/
```

## 使用

```ts
import { ChatClient } from "caloplan-chat";
import { createCPCache } from "caloplan-cache";

const chat = new ChatClient({
  baseURL: "http://localhost:9095",   // fastapi-chat-service
  tokenProvider: () => getJwt(),      // 外部注入 Token（登录/刷新由上层负责）
  cache: createCPCache(),             // 已初始化的 caloplan-cache（结构契约兼容）
});

// 可选：显式恢复本地历史（写操作内部会自动 init）
await chat.init();

// 创建会话 + 发送消息（SSE 流式）
const session = await chat.sessions.create();
const stream = chat.sendMessage(session.id, "帮我分析今天的营养摄入");
for await (const ev of stream) {
  if (ev.type === "text_delta") ui.update(ev.assistantMessage.content);
  if (ev.type === "approval") ui.showConfirm(ev.pendingAction);
  if (ev.type === "done") ui.finish(ev.result);
}

// 历史记录（同步读；先 init 可保证读到恢复后的数据）
const sessions = chat.sessions.list();
const restored = chat.sessions.get(session.id);

// 命中需审批 Tool 时
// （approval 事件携带 pendingAction；也可以从 done.result.needApproval 判断）
// UI 自行决定是否展示确认框
await chat.confirm(action.taskid);   // 批准：执行 tool
await chat.cancel(action.taskid);    // 拒绝：不执行，模型给最终回复
```

### sendMessage 流式事件

`chat.sendMessage(sessionId, content)` 返回 `AsyncIterable<ChatStreamEvent>`，按序产出：

| 事件 | 说明 |
|---|---|
| `{ type: "text_delta", content, assistantMessage }` | 文本增量（可多次）；`assistantMessage` 为 SDK 已实时写回 cache 的累积对象，UI 可直接渲染 |
| `{ type: "approval", pendingAction }` | 命中需审批 Tool（其后必有 `done`）；pendingAction 已持久化 |
| `{ type: "done", result: ChatSendResult }` | 流式完成；`result` 含最终 assistant 消息 / conversationId / needApproval / toolCalls |

流内错误（后端 SSE `error` 事件 / 流中断 / 未收到 `done` 终态）直接以 `ChatError` 抛出（`for await` 循环体会收到异常）。

## API 一览

### ChatClient（主入口）

| 方法 | 说明 |
|---|---|
| `init()` | 从 cache（LocalStorage）恢复本地历史；幂等 |
| `sendMessage(sessionId, content)` | SSE 流式发送：保存 user 消息 → assistant 占位（streaming）→ 逐增量实时写回 cache → done / 抛错 |
| `confirm(taskid)` | 批准审批动作（执行 tool，返回最终回复） |
| `cancel(taskid)` | 拒绝审批动作（不执行 tool，模型给最终回复） |

### sessions（ChatHistory）

| 方法 | 说明 |
|---|---|
| `create({title?})` | 创建会话并写回 cache（id 自动生成，同时用作 `conversation_id`） |
| `list()` | 列出全部会话（最新在前；同步读内存态） |
| `get(sessionId)` | 按 id 获取会话；不存在返回 null |
| `delete(sessionId)` | 删除会话 |
| `clear(sessionId)` | 清空会话消息（保留会话） |
| `appendMessage(sessionId, message)` | 追加消息并写回；第一条 user 消息自动生成标题 |
| `updateMessage(sessionId, messageId, patch)` | 局部更新 `content / status / pendingAction` |

## 与 fastapi-chat-service 的映射

对齐后端 `app/schemas/ai/*` 与 `app/ai/service.py run_chat_stream` 的真实契约（wire 层 snake_case，见 `src/transport/types.ts`）：

| 前端 API | 后端端点 | 请求 | 响应 |
|---|---|---|---|
| `sendMessage` | `POST /api/v1/ai/chat`（`stream: true`） | `{message, conversation_id, history, stream: true}` | SSE 帧流：`text` 增量 → (`approval`) → `done` 终态；AI 失败发 `error` 事件 |
| `confirm / cancel` | `POST /api/v1/ai/approval` | `{taskid, approved}` | `{conversation_id, reply, approved, tool_results, …}` |

**SSE 协议**（后端 `_sse`：`data: <json>\n\n` 帧）：
- `{"type":"text","content":"<增量>"}`：文本增量（可多次）；
- `{"type":"approval","taskid":...,"pending_tools":[...]}`：命中需审批 Tool（其后必有 `done`）；
- `{"type":"done", ...ChatResponse 字段}`：终态。正常分支 `reply` 为完整文本；审批分支 `reply=""`、`need_approval=true` + `taskid/pending_tools`；
- `{"type":"error","detail":"..."}`：AI 调用失败（HTTP 仍为 200）→ SDK 抛 `ChatError(kind=stream)`。

**多模态内容块**（对齐后端 `ChatRequest.message: str | list[ContentBlock]`）：
- `sendMessage(sessionId, content)` 的 `content` 支持纯文本或内容块数组
  `[{type:"text",text:"..."}, {type:"image_url", imageUrl: "url" | {"url": ...}}]`（可含 base64 data URL 图片）；
- 内容块经 `mapper.toBackendContent` 转为 wire 结构（`imageUrl` → `image_url`）后随 `message` / `history` 回传；
- 历史中的内容块 user 消息原样持久化（刷新后图片消息不丢失）；assistant 消息 content 恒为字符串。

- **鉴权**：`Authorization: Bearer <token>`，token 由 `tokenProvider` 注入，SDK 不实现 Token 刷新（401 时抛 `ChatError(kind=auth)`，由上层处理）；
- **history 组装规则**（`src/mapper/ChatMapper.ts`）：只回传**已完成且非空**（空字符串 / 空内容块数组）的 user / assistant 消息；
  system 由服务端管理、tool 由审批快照管理、pending / failed 消息不参与上下文；
- **会话语义**：后端为无状态对话（无 session 概念，`conversation_id` 仅日志关联 / 幂等用），
  因此前端 Session 是纯本地组织单位，`session.id` 直接作为 `conversation_id` 回传，无需维护两套 ID。

## 本地历史缓存（caloplan-cache 接入方式）

**不直接操作 localStorage**：所有读写都经由注入的 cache（结构契约 `ChatCacheLike`，
caloplan-cache 的 `Cache` 类天然满足，无需修改 caloplan-cache 任何代码）。

利用 caloplan-cache 的 producer 语义实现**写回式 read-through**：

1. 构造时 `cache.register("chat_sessions", () => this.sessions)` —— producer 返回权威内存态；
2. `init()` → `cache.get("chat_sessions")` —— 有缓存则恢复；无缓存则 producer 回填空数组并落盘；
3. 每次变更 → 更新内存态 → `cache.refresh("chat_sessions")` —— producer 返回最新内存态并覆盖写回。

```
caloplan-chat（决定存什么：数据结构 / 写入时机 / 删除时机）
    ↓ register / get / refresh / delete
caloplan-cache（决定怎么存：JSON 序列化 + LocalStorage）
    ↓
LocalStorage
```

关键保证：
- 用户消息在**请求发出前**即落盘（请求失败不丢用户输入）；
- 请求失败时 assistant 消息标记 `status=failed` 并落盘，已收内容不丢；
- 页面刷新 → 新 ChatClient 注入同一 cache → `init()` 完整恢复 Session 与 Messages。

> 真实集成验证：`pnpm tsx integration-smoke.ts`（需先构建 `../caloplan-cache` 的 dist）。

## Pending Action / 审批流

后端命中需审批 Tool 时返回 `need_approval=true + taskid + pending_tools`：

```
sendMessage → assistant 消息挂载 pendingAction（含 taskid + tools）并持久化
    ↓
UI 展示确认卡片（SDK 不负责 UI）
    ↓
chat.confirm(taskid)  /  chat.cancel(taskid)
    ↓
POST /api/v1/ai/approval {taskid, approved}
    ↓
本地历史：pendingAction → resolved（记录 outcome），最终回复追加为新的 assistant 消息
```

- pendingAction 随历史持久化，页面刷新后仍可确认（taskid TTL 由后端控制，默认 300s）；
- 审批过期（410）/ 越权（403）→ `ChatError(kind=confirmation)`，本地 pendingAction 保持未解决。

## 错误分类

`ChatError`（`src/errors/ChatError.ts`），字段：`kind / status / code / retryable / message`。

| kind | 触发 |
|---|---|
| `network` | fetch 失败 / 网络不可达 |
| `auth` | tokenProvider 返回空、401 认证失败、403 权限不足（chat 请求） |
| `backend` | 其他 HTTP 错误、响应非合法 JSON |
| `stream` | SSE `error` 事件（AI 调用失败）、流中断 / SSE 解析失败、流提前结束未收到 `done` 终态 |
| `confirmation` | 审批专属：410 过期 / 403 越权 |
| `cache` | caloplan-cache 读写失败（本地历史） |

## 设计决策与偏差说明

1. **SSE 流式**：后端 `stream=true` 时以 SSE 返回（text 增量 + approval + done 终态；AI 失败发
   error 事件）。`sendMessage` 返回 `AsyncIterable<ChatStreamEvent>`（async generator），
   每个文本增量**实时写回 cache**（不等待整个响应完成）。
2. **消息状态**为 `pending / streaming / completed / failed`：占位 assistant 为 `streaming`，
   逐增量累积写回，done 后 `completed`，失败 `failed`（已收内容保留）。
3. **Session 为纯前端概念**（见上表）；不重复维护后端上下文 ID。
4. **`sessions.list()/get()` 为同步读内存态**，写操作内部自动 `init()`；
   若需创建后立刻读到恢复数据，先 `await chat.init()`。
5. **cache 采用结构契约注入**（鸭子类型），不 import caloplan-cache 运行时符号：
   避免构建顺序依赖，同时保持「cache 管怎么存、chat 管存什么」的分离。
6. 依赖仅 `nanoid`（生成 id）；HTTP 用全局 fetch，不引入大型 HTTP 框架。

## 测试

```bash
pnpm test    # 43 个用例（node:test + tsx）
```

覆盖：Session（创建 / 获取 / 列出 / 删除 / 清空）；Message（追加 user / assistant、更新）；
SSE 流式（text 增量事件序列、content 实时累积、**每个增量实时同步 cache**、streaming→completed 状态流转）；
**多模态内容块**（内容块数组 → wire 结构回传、历史数组持久化、空块校验、数组标题生成）；
失败处理（network / backend / auth / stream / confirmation / cache，历史不因失败丢失；
SSE error 事件、未知事件类型、未收到 done 终态）；审批流（approval 事件 → taskid → confirm / cancel → resolved + 最终回复；410 / 403 错误）；页面刷新恢复（chat → cache → LocalStorage）。

## 边界（不做的事）

- 不修改 caloplan-core / caloplan-cache / 其他模块；
- 不让 caloplan-cache 理解 Chat 业务；
- 不直接操作 localStorage；
- 不引入 Pinia / Vue / React / React Native 依赖；
- 不在 SDK 中实现 UI、登录、注册、Token 刷新、全局状态管理；
- 不为未来需求过度抽象（多模态历史回传、模型参数透传等后端落地后再扩展）。
