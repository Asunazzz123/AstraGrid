# Topic-Session 系统设计

## 目标

Telegram Supergroup 中，每个 Topic = 一个独立的 Claude Code / Codex session。用户通过 `@bot device:agent @init` 创建 session，Topic close 时保留 session，reopen 可恢复对话。

## 核心原则

**不维护长驻进程。** 利用 Claude Code（`--session-id`）和 Codex（`codex exec resume`）的磁盘 session 持久化能力，每次消息独立 spawn → 等退出 → 回传结果。Gateway 只维护 `topic_id → session_id` 的映射。

---

## 架构

```
Telegram Supergroup
  ├── Main chat                 ──→  @bot macbook:claude @init [project=name] [task]
  │
  ├── Topic "claude · bot"      ──→  用户发消息 → Gateway → Agent → claude -c -p
  │
  └── Topic "codex · api"       ──→  用户发消息 → Gateway → Agent → codex exec resume

Gateway 新增模块:

  TelegramAdapter (扩展)    SessionManager          SessionStore
  topicId 透传 + API    ←→  生命周期控制       ←→   gateway-sessions.json
        ↓                       ↓
      Router               DevicePool (不变)
  命令/消息分流                  ↓
        ↓                     Agent
      Streamer           executor (扩展 session 参数)
```

---

## Session 模型

```typescript
interface SessionRecord {
  sessionId: string;       // UUID, CLI session ID
  topicId: number;         // Telegram message_thread_id
  chatId: string;          // Supergroup chat ID
  device: string;
  agent: AgentType;        // "claude" | "codex"
  project?: string;
  cwd: string;             // 工作目录完整路径
  state: "active" | "inactive";
  createdAt: number;
  lastActiveAt: number;
}
```

### SessionStore

- 文件：`gateway-sessions.json`（与 `gateway-config.json` 同目录）
- 接口：`save(record)` / `load(chatId, topicId)` / `delete(chatId, topicId)` / `listByChat(chatId)` / `loadAll()` / `updateState(sessionId, state)`
- 启动恢复：Gateway 启动时从文件加载全部记录，所有 session 初始标记为 `inactive`（保守策略，topic 新消息或 reopen 时自动恢复）

---

## 协议变更

### GateToDev.exec 扩展

```typescript
{ type: "exec"
  id: string
  agent: AgentType
  cwd: string
  task: string
  sessionId?: string       // 新增：有值 = 属于某个 session
  isSessionInit?: boolean  // 新增：true = 首次创建 session
  env?: Record<string, string>
  timeout?: number
}
```

### DevToGate.exit 扩展

```typescript
{ type: "exit"
  id: string
  code: number
  signal?: string
  sessionId?: string       // 新增：Codex 首次执行后回传 session ID
}
```

其余消息类型不变（`ack` / `stdout` / `stderr` / `file` / `register` / `pong`）。

### Agent 侧 CLI 参数映射

| agent | isSessionInit=true | isSessionInit=false |
|-------|-------------------|---------------------|
| claude | `claude -p --session-id <id> --name tg-<shortId> "task"` | `claude -c -p "task"` |
| codex | `codex exec "task"`（退出后读 `~/.codex/session_index.jsonl` 取最新 ID） | `codex exec resume <id> "task"` |
| shell | 不支持 session 模式。`@init` 带 shell agent 时 Router 直接拒绝 | shell 始终用一次性 `shell -c` 模式，忽略 sessionId |

---

## Parser 变更

扩展解析结果：

```typescript
type ParsedResult =
  | { type: "init"; device: string; agent: AgentType; project?: string; task?: string }
  | { type: "exec"; device: string; agent: AgentType; project?: string; task: string }
  | { type: "plain"; text: string }
  | { type: "kill" }
  | { type: "status" }
  | null;
```

解析规则：
- `@bot <device>:<agent> @init [project=<name>] [task...]` → `init`
- `@bot <device>:<agent> [project=<name>] <task...>` → `exec`（向后兼容现有模式）
- 其余文本 → `plain`

---

## Router 变更

Router 重构为类方法，引入 SessionManager：

```
handle(msg: IncomingMessage):
  1. 若 msg.topicId 存在 → 查 SessionStore → 找到 session 则 routeToSession
     - state=inactive 的 session 自动恢复为 active
  2. 否则解析命令：
     - init → SessionManager.create() + createForumTopic + 发送首次 exec
     - exec → 现有一次性逻辑
     - kill → SessionManager.kill()
     - status → 查询 session 状态
     - plain → 主群聊忽略，提示用法
```

**并发控制**：同一 session 的消息按到达顺序排队（Promise chain），确保前一个 spawn 完成后再处理下一条。

---

## SessionManager

接口：
- `create(chatId, device, agent, project?, task?)` → 生成 sessionId，调 Telegram API `createForumTopic`，存 SessionStore，发 `exec`（isSessionInit=true）
- `kill(sessionId)` → 删 SessionStore 记录，可选调 Telegram API `deleteForumTopic`
- `setActive(sessionId)` / `setInactive(sessionId)`
- `getByTopic(chatId, topicId)` → SessionRecord | undefined
- `listByChat(chatId)` → SessionRecord[]

---

## Executor 变更（Agent 侧）

`execute()` 函数新增 session 参数处理：

- claude + sessionId + isSessionInit → `spawn("claude", ["-p", "--session-id", sessionId, "--name", `tg-${shortId}`, task])`
- claude + sessionId + !isSessionInit → `spawn("claude", ["-c", "-p", task])`
- codex + sessionId + isSessionInit → `spawn("codex", ["exec", task])`，退出后读 `~/.codex/session_index.jsonl` 取最新 `id`，通过 `exit.sessionId` 回传
- codex + sessionId + !isSessionInit → `spawn("codex", ["exec", "resume", sessionId, task])`
- 无 sessionId → 现有一次性逻辑不变

**Codex session ID 获取**：首次 `codex exec` 完成后，读 `~/.codex/session_index.jsonl`，取最后一行 JSON 的 `id` 字段，附在 `exit` 消息的 `sessionId` 字段回传 Gateway。

---

## Telegram 集成

### Adapter 扩展

`IncomingMessage` 增加字段：
```typescript
topicId?: number
isTopicMessage?: boolean
```

`TelegramAdapter.on("text")` 从 `ctx.message.message_thread_id` 和 `ctx.message.is_topic_message` 提取，透传到 `IncomingMessage`。

### Topic 生命周期检测

结合两种方式：
- **主动检测**：Gateway 定时（每 60s）通过 `getForumTopic` 检查已知 topic 的状态，对比内存中的 state，发现变更则更新
- **被动触发**：用户发消息到 topic 时，Router 自然感知并恢复 inactive → active

### Topic 名称

初始自动生成 `{agent}@{device} · {project}`，Topic 创建后用户可在 Telegram 中手动 rename，不影响功能。

---

## 端到端消息流

### 创建 Session

```
用户[主群聊]: @bot macbook:claude @init project=bot 帮我写CSV解析
  → Parser → { type: "init", device: "macbook", agent: "claude", project: "bot", task: "帮我写CSV解析" }
  → SessionManager.create()
      → 生成 sessionId = "uuid-abc"
      → Telegram API createForumTopic(chatId, "claude@macbook · bot") → topicId=42
      → SessionStore.save({ sessionId, topicId: 42, ... })
      → pool.send("macbook", { exec, sessionId: "uuid-abc", isSessionInit: true })
  → Agent: spawn("claude", ["-p", "--session-id", "uuid-abc", "--name", "tg-uuid-abc", "帮我写CSV解析"])
  → stdout/stderr → Streamer → topic 42
  → exit 0 → "✅ Task xxx exited" 发到 topic 42
```

### 继续对话

```
用户[topic 42]: 加个错误处理
  → Router: sessions.getByTopic(chatId, 42) → sessionId="uuid-abc"
  → pool.send("macbook", { exec, sessionId: "uuid-abc", isSessionInit: false })
  → Agent: spawn("claude", ["-c", "-p", "加个错误处理"])
  → 自动加载 -c 上下文 → 回复 → topic 42
```

### Close + Reopen

```
用户 close topic 42 → 下次检测发现状态变更 → setInactive("uuid-abc")
用户 reopen topic 42 → 检测到 → setActive("uuid-abc")
用户发消息 → routeToSession → spawn("claude", ["-c", "-p", ...])
```

### Kill

```
用户[topic 42]: /kill
  → Parser → { type: "kill" }
  → sessions.getByTopic → "uuid-abc"
  → pool.send("macbook", exec 清理) // 可选：删 session 文件
  → SessionStore.delete("uuid-abc")
  → 可选 Telegram API deleteForumTopic(chatId, 42)
```

---

## 实现优先级

| 优先级 | 内容 | 涉及模块 |
|--------|------|----------|
| P0 | 协议扩展（exec.sessionId/isSessionInit, exit.sessionId） | shared/protocol.ts |
| P0 | Executor session 模式（claude/codex init/resume 参数映射） | agent/executor.ts |
| P0 | SessionStore 文件持久化 | gateway/session-store.ts |
| P0 | SessionManager 生命周期控制 | gateway/session-manager.ts |
| P0 | Parser 扩展 + Router 重构（命令分流 + topic 路由） | gateway/parser.ts, router.ts |
| P0 | TelegramAdapter 扩展（topicId 透传 + createForumTopic） | gateway/adapters/telegram.ts, base.ts |
| P0 | Gateway index.ts 组装 | gateway/index.ts |
| P1 | Topic 状态轮询检测（close/reopen） | gateway/session-manager.ts |
| P1 | Codex session ID 自动提取 | agent/executor.ts |
| P2 | Session 文件清理（/kill 远端） | agent/executor.ts |
| P2 | 消息队列（同 session 并发串行化） | gateway/session-manager.ts |
