# Topic-Session System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement Telegram Supergroup Topic ↔ Claude Code / Codex session mapping, with persistent session metadata.

**Architecture:** Extend the existing one-shot exec flow with two optional fields (`sessionId`, `isSessionInit`) on the exec protocol message. Gateway tracks `topic_id → session_id` in a JSON file. Each user message spawns an independent CLI process that loads/saves session context via Claude Code's `--session-id`/`-c` flags or Codex's `exec resume`. No long-running processes.

**Tech Stack:** TypeScript, existing ws/Telegraf stack, Node.js fs for persistence.

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `packages/shared/src/protocol.ts` | Modify | Add session fields to exec/exit types |
| `packages/gateway/src/session-store.ts` | Create | File-based SessionRecord CRUD |
| `packages/gateway/src/adapters/base.ts` | Modify | Add topicId/isTopicMessage to IncomingMessage |
| `packages/gateway/src/adapters/telegram.ts` | Modify | Extract topic fields, add createForumTopic/deleteForumTopic |
| `packages/gateway/src/parser.ts` | Modify | New ParsedResult union, @init / /kill / /status parsing |
| `packages/gateway/src/session-manager.ts` | Create | Session lifecycle, concurrency queue |
| `packages/gateway/src/streamer.ts` | Modify | Add onSessionId callback for codex session ID capture |
| `packages/gateway/src/router.ts` | Rewrite | Function → class, command dispatch, topic routing |
| `packages/agent/src/executor.ts` | Modify | Session-aware CLI args, codex session ID extraction |
| `packages/agent/src/index.ts` | Modify | Handle session_kill message |
| `packages/gateway/src/index.ts` | Modify | Wire new modules |

---

### Task 1: Protocol Extension

**Files:**
- Modify: `packages/shared/src/protocol.ts`

- [ ] **Step 1: Add sessionId and isSessionInit to GateToDev.exec**

In `packages/shared/src/protocol.ts`, change the exec union member from:

```typescript
  | { type: "exec"; id: string; agent: AgentType; cwd: string; task: string; env?: Record<string, string>; timeout?: number }
```

to:

```typescript
  | { type: "exec"; id: string; agent: AgentType; cwd: string; task: string; sessionId?: string; isSessionInit?: boolean; env?: Record<string, string>; timeout?: number }
```

- [ ] **Step 2: Add sessionId to DevToGate.exit**

Change the exit union member from:

```typescript
  | { type: "exit"; id: string; code: number; signal?: string }
```

to:

```typescript
  | { type: "exit"; id: string; code: number; signal?: string; sessionId?: string }
```

- [ ] **Step 3: Add session types to GateToDev and DevToGate**

Add these new union members:

To `GateToDev`:
```typescript
  | { type: "session_kill"; sessionId: string }
```

To `DevToGate`:
```typescript
  | { type: "session_error"; id: string; error: string }
```

- [ ] **Step 4: Update type guards**

In `isGateToDev`, add `"session_kill"` to the includes list.

In `isDevToGate`, add `"session_error"` to the includes list.

- [ ] **Step 5: Verify compiles**

Run: `npm run build`
Expected: Clean build (new fields are optional, existing code unaffected)

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/protocol.ts
git commit -m "feat: add sessionId, isSessionInit, session_kill, session_error to protocol messages"
```

---

### Task 2: SessionStore

**Files:**
- Create: `packages/gateway/src/session-store.ts`

- [ ] **Step 1: Create session-store.ts**

```typescript
import { readFileSync, writeFileSync, existsSync } from "fs";
import { AgentType } from "@bot/shared";

export interface SessionRecord {
  sessionId: string;
  topicId: number;
  chatId: string;
  device: string;
  agent: AgentType;
  project?: string;
  cwd: string;
  state: "active" | "inactive";
  createdAt: number;
  lastActiveAt: number;
}

export class SessionStore {
  private records: SessionRecord[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadFromDisk();
  }

  save(record: SessionRecord): void {
    const idx = this.records.findIndex(
      (r) => r.chatId === record.chatId && r.topicId === record.topicId
    );
    if (idx >= 0) {
      this.records[idx] = record;
    } else {
      this.records.push(record);
    }
    this.persist();
  }

  load(chatId: string, topicId: number): SessionRecord | undefined {
    return this.records.find((r) => r.chatId === chatId && r.topicId === topicId);
  }

  getBySessionId(sessionId: string): SessionRecord | undefined {
    return this.records.find((r) => r.sessionId === sessionId);
  }

  delete(chatId: string, topicId: number): boolean {
    const idx = this.records.findIndex(
      (r) => r.chatId === chatId && r.topicId === topicId
    );
    if (idx >= 0) {
      this.records.splice(idx, 1);
      this.persist();
      return true;
    }
    return false;
  }

  deleteBySessionId(sessionId: string): boolean {
    const idx = this.records.findIndex((r) => r.sessionId === sessionId);
    if (idx >= 0) {
      this.records.splice(idx, 1);
      this.persist();
      return true;
    }
    return false;
  }

  listByChat(chatId: string): SessionRecord[] {
    return this.records.filter((r) => r.chatId === chatId);
  }

  loadAll(): SessionRecord[] {
    return [...this.records];
  }

  updateState(sessionId: string, state: "active" | "inactive"): void {
    const r = this.records.find((r) => r.sessionId === sessionId);
    if (r) {
      r.state = state;
      r.lastActiveAt = Date.now();
      this.persist();
    }
  }

  updateCliSessionId(oldSessionId: string, newSessionId: string): void {
    const r = this.records.find((r) => r.sessionId === oldSessionId);
    if (r) {
      r.sessionId = newSessionId;
      this.persist();
    }
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(this.filePath)) {
        const data = readFileSync(this.filePath, "utf-8");
        this.records = JSON.parse(data);
      }
    } catch {
      console.warn("[session-store] Failed to load, starting with empty store");
      this.records = [];
    }
  }
}
```

- [ ] **Step 2: Verify compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/session-store.ts
git commit -m "feat: add SessionStore for persistent session metadata"
```

---

### Task 3: Adapter Extension

**Files:**
- Modify: `packages/gateway/src/adapters/base.ts`
- Modify: `packages/gateway/src/adapters/telegram.ts`

- [ ] **Step 1: Extend IncomingMessage in base.ts**

Read `packages/gateway/src/adapters/base.ts`. Replace the `IncomingMessage` interface:

```typescript
export interface IncomingMessage {
  chatId: string;
  userId: string;
  text: string;
  platform: string;
  topicId?: number;
  isTopicMessage?: boolean;
}
```

All other content in base.ts remains unchanged.

- [ ] **Step 2: Extract topicId/isTopicMessage in telegram.ts**

Read `packages/gateway/src/adapters/telegram.ts`. In the `start()` method's `on("text")` handler, update the IncomingMessage construction.

Current:
```typescript
const msg: IncomingMessage = {
  chatId: String(ctx.chat.id),
  userId: String(ctx.from?.id ?? "unknown"),
  text: ctx.message.text,
  platform: "telegram",
};
```

Replace with:
```typescript
const msg: IncomingMessage = {
  chatId: String(ctx.chat.id),
  userId: String(ctx.from?.id ?? "unknown"),
  text: ctx.message.text,
  platform: "telegram",
  topicId: ctx.message.message_thread_id,
  isTopicMessage: ctx.message.is_topic_message ?? false,
};
```

- [ ] **Step 3: Add telegram getter and forum topic methods to TelegramAdapter class**

Add these inside the TelegramAdapter class body (after the constructor):

```typescript
get telegram() {
  return this.bot.telegram;
}

async createForumTopic(chatId: string, name: string): Promise<number> {
  const result = await this.bot.telegram.createForumTopic(
    Number(chatId),
    name
  );
  return result.message_thread_id;
}

async deleteForumTopic(chatId: string, topicId: number): Promise<void> {
  await this.bot.telegram.deleteForumTopic(Number(chatId), topicId);
}
```

- [ ] **Step 4: Verify compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/adapters/base.ts packages/gateway/src/adapters/telegram.ts
git commit -m "feat: add topicId/isTopicMessage to adapter, forum topic methods to Telegram"
```

---

### Task 4: Parser Extension

**Files:**
- Modify: `packages/gateway/src/parser.ts`

- [ ] **Step 1: Read current parser.ts**

Read `packages/gateway/src/parser.ts` to confirm current content.

- [ ] **Step 2: Replace parser.ts with extended version**

```typescript
import { AgentType } from "@bot/shared";

export type ParsedResult =
  | { type: "init"; device: string; agent: AgentType; project?: string; task?: string }
  | { type: "exec"; device: string; agent: AgentType; project?: string; task: string }
  | { type: "kill" }
  | { type: "status" }
  | { type: "sessions" }
  | null;

const VALID_AGENTS = ["claude", "codex", "shell"] as const;

// Syntax:
//   @bot <device>:<agent> @init [project=<name>] [task...]
//   @bot <device>:<agent> [project=<name>] <task...>
//   /kill
//   /status
//   /sessions
export function parse(text: string): ParsedResult {
  const trimmed = text.trim();

  // Standalone slash commands
  if (/^\/kill$/i.test(trimmed)) return { type: "kill" };
  if (/^\/status$/i.test(trimmed)) return { type: "status" };
  if (/^\/sessions$/i.test(trimmed)) return { type: "sessions" };

  // @bot commands
  const botMatch = trimmed.match(/^@bot\s+(\w+):(\w+)(?:\s+@init)?(?:\s+project=(\S+))?(?:\s+(.+))?$/s);
  if (!botMatch) return null;

  const [, device, agent, project, rest] = botMatch;

  if (!(VALID_AGENTS as readonly string[]).includes(agent)) return null;

  const isInit = /\s+@init\b/.test(trimmed);

  if (isInit) {
    return {
      type: "init",
      device,
      agent: agent as AgentType,
      project: project || undefined,
      task: rest?.trim() || undefined,
    };
  }

  // exec requires a task
  if (!rest?.trim()) return null;

  return {
    type: "exec",
    device,
    agent: agent as AgentType,
    project: project || undefined,
    task: rest.trim(),
  };
}
```

- [ ] **Step 3: Verify compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/parser.ts
git commit -m "feat: extend parser with @init, /kill, /status, /sessions commands"
```

---

### Task 5: SessionManager

**Files:**
- Create: `packages/gateway/src/session-manager.ts`

- [ ] **Step 1: Create session-manager.ts**

```typescript
import { randomUUID } from "crypto";
import { SessionStore, SessionRecord } from "./session-store";
import { DevicePool } from "./device-pool";
import { TelegramAdapter } from "./adapters/telegram";
import { AgentType } from "@bot/shared";

export class SessionManager {
  private store: SessionStore;
  private pool: DevicePool;
  private adapter: TelegramAdapter;
  private taskToSession = new Map<string, string>();   // taskId → logical sessionId
  private queues = new Map<string, Promise<void>>();    // sessionId → queue promise

  constructor(store: SessionStore, pool: DevicePool, adapter: TelegramAdapter) {
    this.store = store;
    this.pool = pool;
    this.adapter = adapter;
    // On startup, mark all sessions as inactive (conservative)
    for (const r of this.store.loadAll()) {
      this.store.updateState(r.sessionId, "inactive");
    }
  }

  /** Create a session record and Telegram topic. Does NOT send exec. */
  async create(
    chatId: string,
    device: string,
    agent: AgentType,
    project: string | undefined,
    cwd: string
  ): Promise<SessionRecord> {
    const sessionId = randomUUID();
    const topicName = `${agent}@${device}${project ? ` · ${project}` : ""}`;
    const topicId = await this.adapter.createForumTopic(chatId, topicName);

    const record: SessionRecord = {
      sessionId,
      topicId,
      chatId,
      device,
      agent,
      project,
      cwd,
      state: "active",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.store.save(record);
    return record;
  }

  /** Send an input message to an existing session (spawns resume process). */
  sendInput(
    sessionId: string,
    device: string,
    agent: AgentType,
    cwd: string,
    task: string
  ): string {
    const taskId = randomUUID();
    this.taskToSession.set(taskId, sessionId);
    this.pool.send(device, {
      type: "exec",
      id: taskId,
      agent,
      cwd,
      task,
      sessionId,
      isSessionInit: false,
    });
    return taskId;
  }

  /** Send the first message to a brand-new session (spawns init process). */
  sendInit(
    sessionId: string,
    device: string,
    agent: AgentType,
    cwd: string,
    task: string
  ): string {
    const taskId = randomUUID();
    this.taskToSession.set(taskId, sessionId);
    this.pool.send(device, {
      type: "exec",
      id: taskId,
      agent,
      cwd,
      task,
      sessionId,
      isSessionInit: true,
    });
    return taskId;
  }

  /** Enqueue a blocking operation for a session (serial execution, P2 wiring). */
  enqueue(sessionId: string, fn: () => Promise<void>): void {
    const prev = this.queues.get(sessionId) || Promise.resolve();
    const next = prev.then(fn, fn); // run fn even if previous rejected
    this.queues.set(sessionId, next);
  }

  getByTopic(chatId: string, topicId: number): SessionRecord | undefined {
    return this.store.load(chatId, topicId);
  }

  listByChat(chatId: string): SessionRecord[] {
    return this.store.listByChat(chatId);
  }

  setActive(sessionId: string): void {
    this.store.updateState(sessionId, "active");
  }

  setInactive(sessionId: string): void {
    this.store.updateState(sessionId, "inactive");
  }

  async kill(sessionId: string): Promise<void> {
    const record = this.store.getBySessionId(sessionId);
    if (!record) return;

    try {
      await this.adapter.deleteForumTopic(record.chatId, record.topicId);
    } catch {
      // Topic may already be deleted
    }

    // Notify agent to clean up session files (best-effort)
    this.pool.send(record.device, {
      type: "session_kill",
      sessionId,
    });

    this.store.deleteBySessionId(sessionId);
    this.queues.delete(sessionId);
  }

  /** Called when exit message carries a codex sessionId — update the mapping. */
  updateCliSessionId(taskId: string, cliSessionId: string): void {
    const logicalId = this.taskToSession.get(taskId);
    if (!logicalId) return;
    this.taskToSession.delete(taskId);
    this.store.updateCliSessionId(logicalId, cliSessionId);
  }
}
```

- [ ] **Step 2: Verify compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/session-manager.ts
git commit -m "feat: add SessionManager for session lifecycle and serial execution"
```

---

### Task 6: Streamer Update

**Files:**
- Modify: `packages/gateway/src/streamer.ts`

- [ ] **Step 1: Read current streamer.ts**

Read `packages/gateway/src/streamer.ts` to confirm current content.

- [ ] **Step 2: Add onSessionId callback**

Add a private field to the Streamer class:

```typescript
private sessionIdHandler?: (taskId: string, sessionId: string) => void;
```

Add a public method:

```typescript
onSessionId(handler: (taskId: string, sessionId: string) => void): void {
  this.sessionIdHandler = handler;
}
```

In the `handle` method, inside `if (msg.type === "exit")`, add the sessionId handler call before the existing buffer/send logic:

```typescript
if (msg.type === "exit") {
  if (msg.sessionId) {
    this.sessionIdHandler?.(msg.id, msg.sessionId);
  }
  if (state.buffer.length > 0) {
    state.adapter.sendReply(state.chatId, state.buffer);
    state.buffer = "";
  }
  const icon = msg.code === 0 ? "✅" : "❌";
  state.adapter.sendReply(state.chatId, `${icon} Task ${msg.id.slice(0, 8)} exited with code ${msg.code}`);
  this.tasks.delete(msg.id);
}
```

Also in the `handle` method, add handling for the new `session_error` message type (after `if (msg.type === "ack") return;`):

```typescript
if (msg.type === "session_error") {
  const state = this.tasks.get(msg.id);
  if (state) {
    state.adapter.sendReply(state.chatId, `❌ Session error: ${msg.error}`);
  }
  return;
}
```

- [ ] **Step 3: Verify compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/streamer.ts
git commit -m "feat: add sessionId handler callback and session_error support to Streamer"
```

---

### Task 7: Router Refactor

**Files:**
- Modify: `packages/gateway/src/router.ts`

- [ ] **Step 1: Read current router.ts**

Read `packages/gateway/src/router.ts` to confirm current content.

- [ ] **Step 2: Replace router.ts with class-based Router**

```typescript
import { randomUUID } from "crypto";
import { parse, ParsedResult } from "./parser";
import { DevicePool } from "./device-pool";
import { SessionManager } from "./session-manager";
import { Streamer } from "./streamer";
import { BotAdapter, IncomingMessage } from "./adapters/base";
import { TelegramAdapter } from "./adapters/telegram";

export class Router {
  constructor(
    private pool: DevicePool,
    private sessions: SessionManager,
    private adapter: TelegramAdapter,
    private streamer: Streamer
  ) {}

  async handle(msg: IncomingMessage): Promise<void> {
    // 1. Topic message → route to session
    if (msg.topicId && msg.isTopicMessage) {
      await this.handleTopicMessage(msg);
      return;
    }

    // 2. Parse command from main chat
    const parsed = parse(msg.text);
    if (!parsed) {
      await this.adapter.sendReply(
        msg.chatId,
        [
          "Usage:",
          "  @bot <device>:<agent> @init [project=<name>] [task]",
          "  @bot <device>:<agent> [project=<name>] <task>",
          "  /kill     — end session (inside topic)",
          "  /status   — session status (inside topic)",
          "  /sessions — list sessions in this chat",
        ].join("\n")
      );
      return;
    }

    switch (parsed.type) {
      case "init":
        await this.handleInit(msg.chatId, parsed);
        break;
      case "exec":
        this.handleExec(msg.chatId, parsed);
        break;
      case "kill":
        await this.adapter.sendReply(msg.chatId, "❌ /kill must be used inside a topic.");
        break;
      case "status":
        await this.adapter.sendReply(msg.chatId, "❌ /status must be used inside a topic.");
        break;
      case "sessions":
        await this.handleList(msg.chatId);
        break;
    }
  }

  private async handleTopicMessage(msg: IncomingMessage): Promise<void> {
    const session = this.sessions.getByTopic(msg.chatId, msg.topicId!);
    if (!session) {
      await this.adapter.sendReply(msg.chatId, "No active session here. Use @bot device:agent @init in the main chat.");
      return;
    }

    // Auto-recover from inactive
    if (session.state === "inactive") {
      this.sessions.setActive(session.sessionId);
    }

    const trimmed = msg.text.trim();

    // Special commands inside topic
    if (/^\/kill$/i.test(trimmed)) {
      await this.sessions.kill(session.sessionId);
      await this.adapter.sendReply(msg.chatId, `🛑 Session \`${session.sessionId.slice(0, 8)}\` killed.`);
      return;
    }

    if (/^\/status$/i.test(trimmed)) {
      await this.adapter.sendReply(
        msg.chatId,
        [
          `📋 Session \`${session.sessionId.slice(0, 8)}\``,
          `   Device: ${session.device}`,
          `   Agent: ${session.agent}`,
          `   Project: ${session.project || "default"}`,
          `   CWD: ${session.cwd}`,
          `   State: ${session.state}`,
          `   Created: ${new Date(session.createdAt).toISOString()}`,
        ].join("\n")
      );
      return;
    }

    // Route plain text to session (serialized via queue)
    const taskId = this.sessions.sendInput(
      session.sessionId,
      session.device,
      session.agent,
      session.cwd,
      trimmed
    );

    this.streamer.register(taskId, session.chatId, this.adapter as unknown as BotAdapter);
  }

  private async handleInit(
    chatId: string,
    parsed: ParsedResult & { type: "init" }
  ): Promise<void> {
    const dev = this.pool.getDevice(parsed.device);

    if (!dev?.online) {
      const online = this.pool.listDevices().map((d) => d.device).join(", ") || "none";
      await this.adapter.sendReply(chatId, `❌ Device "${parsed.device}" offline or not found. Online: ${online}`);
      return;
    }

    if (!dev.agents.includes(parsed.agent)) {
      await this.adapter.sendReply(chatId, `❌ Device "${parsed.device}" has no "${parsed.agent}" agent. Available: ${dev.agents.join(", ")}`);
      return;
    }

    if (parsed.agent === "shell") {
      await this.adapter.sendReply(chatId, `❌ Session mode not supported for shell agent. Use: @bot ${parsed.device}:shell <command>`);
      return;
    }

    const cwd = parsed.project
      ? dev.projects.find((p) => p === parsed.project || p.endsWith("/" + parsed.project)) ?? dev.projects[0] ?? process.cwd()
      : dev.projects[0] ?? process.cwd();

    // Create session record + Telegram topic
    const record = await this.sessions.create(chatId, parsed.device, parsed.agent, parsed.project, cwd);

    if (parsed.task) {
      // Send initial task
      const taskId = this.sessions.sendInit(
        record.sessionId,
        parsed.device,
        parsed.agent,
        cwd,
        parsed.task
      );
      this.streamer.register(taskId, chatId, this.adapter as unknown as BotAdapter);
    }

    const label = parsed.task
      ? `✅ Session \`${record.sessionId.slice(0, 8)}\` created. Topic: ${parsed.agent}@${parsed.device}${parsed.project ? ` · ${parsed.project}` : ""}`
      : `✅ Session \`${record.sessionId.slice(0, 8)}\` created. Send your first message in the topic.`;

    await this.adapter.sendReply(chatId, label);
  }

  private handleExec(
    chatId: string,
    parsed: ParsedResult & { type: "exec" }
  ): void {
    const dev = this.pool.getDevice(parsed.device);

    if (!dev?.online) {
      this.adapter.sendReply(chatId, `❌ Device "${parsed.device}" offline.`);
      return;
    }

    if (!dev.agents.includes(parsed.agent)) {
      this.adapter.sendReply(chatId, `❌ Device has no "${parsed.agent}" agent.`);
      return;
    }

    const cwd = parsed.project
      ? dev.projects.find((p) => p === parsed.project || p.endsWith("/" + parsed.project)) ?? dev.projects[0] ?? process.cwd()
      : dev.projects[0] ?? process.cwd();

    const taskId = randomUUID();
    this.pool.send(parsed.device, {
      type: "exec",
      id: taskId,
      agent: parsed.agent,
      cwd,
      task: parsed.task,
    });

    this.streamer.register(taskId, chatId, this.adapter as unknown as BotAdapter);
    this.adapter.sendReply(chatId, `🚀 Task \`${taskId.slice(0, 8)}\` dispatched to ${parsed.device}`);
  }

  private async handleList(chatId: string): Promise<void> {
    const sessions = this.sessions.listByChat(chatId);
    if (sessions.length === 0) {
      await this.adapter.sendReply(chatId, "No sessions in this chat.");
      return;
    }
    const lines = sessions.map(
      (s) => `  [${s.state === "active" ? "●" : "○"}] \`${s.sessionId.slice(0, 8)}\` — ${s.agent}@${s.device} · ${s.project || "default"} (topic ${s.topicId})`
    );
    await this.adapter.sendReply(chatId, ["Sessions:", ...lines].join("\n"));
  }
}
```

- [ ] **Step 3: Verify compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/router.ts
git commit -m "feat: refactor Router to class with session routing and command dispatch"
```

---

### Task 8: Executor Session Mode

**Files:**
- Modify: `packages/agent/src/executor.ts`

- [ ] **Step 1: Read current executor.ts**

Read `packages/agent/src/executor.ts` to confirm current content.

- [ ] **Step 2: Add session-aware CLI argument mapping**

Replace the `AGENT_CMD` constant with a function that respects session fields:

```typescript
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

function getAgentCmd(
  agent: AgentType,
  cwd: string,
  task: string,
  sessionId?: string,
  isSessionInit?: boolean
): { cmd: string; args: string[] } {
  switch (agent) {
    case "claude":
      if (sessionId && isSessionInit) {
        const shortId = sessionId.slice(0, 8);
        return { cmd: "claude", args: ["-p", "--session-id", sessionId, "--name", `tg-${shortId}`, task] };
      }
      if (sessionId && !isSessionInit) {
        return { cmd: "claude", args: ["-c", "-p", task] };
      }
      return { cmd: "claude", args: ["-p", task] };

    case "codex":
      if (sessionId && isSessionInit) {
        return { cmd: "codex", args: ["exec", task] };
      }
      if (sessionId && !isSessionInit) {
        return { cmd: "codex", args: ["exec", "resume", sessionId, task] };
      }
      return { cmd: "codex", args: ["exec", task] };

    case "shell":
      return { cmd: process.env.SHELL || "/bin/sh", args: ["-c", task] };
  }
}

function getLatestCodexSessionId(): string | undefined {
  try {
    const indexPath = join(homedir(), ".codex", "session_index.jsonl");
    if (!existsSync(indexPath)) return undefined;
    const lines = readFileSync(indexPath, "utf-8").trim().split("\n");
    const last = lines[lines.length - 1];
    if (!last) return undefined;
    const entry = JSON.parse(last);
    return entry.id as string | undefined;
  } catch {
    return undefined;
  }
}
```

- [ ] **Step 3: Update execute() to use getAgentCmd and handle codex session ID**

In the `execute` function:

Change the spawn setup from:
```typescript
const { cmd, args } = AGENT_CMD[agent](cwd, task);
```

to:
```typescript
const { sessionId, isSessionInit } = msg;
const { cmd, args } = getAgentCmd(agent, cwd, task, sessionId, isSessionInit);
```

In the `proc.on("exit", ...)` handler, change:
```typescript
send({ type: "exit", id, code: code ?? 1, signal: signal ?? undefined });
```

to:
```typescript
// For codex first exec, extract the session ID
let exitSessionId: string | undefined;
if (agent === "codex" && isSessionInit && code === 0) {
  exitSessionId = getLatestCodexSessionId();
}
send({ type: "exit", id, code: code ?? 1, signal: signal ?? undefined, sessionId: exitSessionId });
```

- [ ] **Step 4: Remove the old AGENT_CMD constant**

Delete the `AGENT_CMD` Record entirely (replaced by `getAgentCmd` function).

- [ ] **Step 5: Verify compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 6: Commit**

```bash
git add packages/agent/src/executor.ts
git commit -m "feat: add session-aware CLI argument mapping and codex session ID extraction"
```

---

### Task 9: Agent Index Update

**Files:**
- Modify: `packages/agent/src/index.ts`

- [ ] **Step 1: Read current agent index.ts**

Read `packages/agent/src/index.ts` to confirm current content.

- [ ] **Step 2: Add session_kill message handling**

In the `conn.connect` callback, add a case for `session_kill`:

```typescript
case "session_kill": {
  console.log(`[agent] Session ${msg.sessionId} kill requested — cleaning up`);
  // Clean up session files (best-effort)
  const { execSync } = await import("child_process");
  try {
    // Claude Code sessions
    const claudeDir = join(homedir(), ".claude", "projects");
    if (existsSync(claudeDir)) {
      const dirs = readdirSync(claudeDir);
      for (const dir of dirs) {
        const sessionFile = join(claudeDir, dir, `${msg.sessionId}.jsonl`);
        if (existsSync(sessionFile)) {
          unlinkSync(sessionFile);
          console.log(`[agent] Deleted claude session file: ${sessionFile}`);
        }
      }
    }
  } catch { /* ignore */ }
  try {
    // Codex sessions
    const codexSessionsDir = join(homedir(), ".codex", "sessions");
    if (existsSync(codexSessionsDir)) {
      // codex sessions are stored by year/<id>.jsonl
      const years = readdirSync(codexSessionsDir);
      for (const year of years) {
        const sessionFile = join(codexSessionsDir, year, `${msg.sessionId}.jsonl`);
        if (existsSync(sessionFile)) {
          unlinkSync(sessionFile);
          console.log(`[agent] Deleted codex session file: ${sessionFile}`);
        }
      }
    }
  } catch { /* ignore */ }
  break;
}
```

Wait — `index.ts` is not using top-level await, so `import("child_process")` with await won't work in the current structure. Let me use the synchronous version instead and add the necessary imports at the top.

Add imports at the top of index.ts:
```typescript
import { existsSync, readdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
```

Then the session_kill handler:
```typescript
case "session_kill": {
  console.log(`[agent] Session ${msg.sessionId} kill requested — cleaning up`);
  try {
    const claudeDir = join(homedir(), ".claude", "projects");
    if (existsSync(claudeDir)) {
      const dirs = readdirSync(claudeDir);
      for (const dir of dirs) {
        const sessionFile = join(claudeDir, dir, `${msg.sessionId}.jsonl`);
        if (existsSync(sessionFile)) {
          unlinkSync(sessionFile);
          console.log(`[agent] Deleted claude session file: ${sessionFile}`);
        }
      }
    }
  } catch { /* ignore */ }
  try {
    const codexSessionsDir = join(homedir(), ".codex", "sessions");
    if (existsSync(codexSessionsDir)) {
      const years = readdirSync(codexSessionsDir);
      for (const year of years) {
        const sessionFile = join(codexSessionsDir, year, `${msg.sessionId}.jsonl`);
        if (existsSync(sessionFile)) {
          unlinkSync(sessionFile);
          console.log(`[agent] Deleted codex session file: ${sessionFile}`);
        }
      }
    }
  } catch { /* ignore */ }
  break;
}
```

Also update the `switch` cases to include `session_kill` alongside `exec` and `cancel`:

```typescript
switch (msg.type) {
  case "exec": { /* existing */ break; }
  case "cancel": { /* existing */ break; }
  case "session_kill": { /* new handler */ break; }
}
```

- [ ] **Step 3: Verify compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/agent/src/index.ts
git commit -m "feat: add session_kill handler with session file cleanup"
```

---

### Task 10: Gateway Index Assembly

**Files:**
- Modify: `packages/gateway/src/index.ts`

- [ ] **Step 1: Read current gateway index.ts**

Read `packages/gateway/src/index.ts` to confirm current content.

- [ ] **Step 2: Replace index.ts to wire all new modules**

```typescript
import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { GatewayConfig } from "@bot/shared";
import { DevicePool } from "./device-pool";
import { parse } from "./parser";
import { Router } from "./router";
import { Streamer } from "./streamer";
import { SessionStore } from "./session-store";
import { SessionManager } from "./session-manager";
import { TelegramAdapter } from "./adapters/telegram";

const configPath = resolve(process.env.GATEWAY_CONFIG || "gateway-config.json");
let config: GatewayConfig;

try {
  config = JSON.parse(readFileSync(configPath, "utf-8"));
} catch {
  console.error(`Gateway config not found at ${configPath}. Set GATEWAY_CONFIG env or create the file.`);
  process.exit(1);
}

if (config.proxy) {
  console.log(`[gateway] Using proxy: ${config.proxy}`);
}

const pool = new DevicePool(config.wsPort, config.tokens);
const adapter = new TelegramAdapter(config.telegramToken, config.proxy);
const streamer = new Streamer();

// Session persistence file next to config
const sessionsPath = resolve(dirname(configPath), "gateway-sessions.json");
const store = new SessionStore(sessionsPath);
const sessions = new SessionManager(store, pool, adapter);

// Wire codex session ID capture: when an exit message carries a codex sessionId,
// update the session record mapping
streamer.onSessionId((taskId, codexSessionId) => {
  sessions.updateCliSessionId(taskId, codexSessionId);
});

const router = new Router(pool, sessions, adapter, streamer);

// Wire device messages → streamer
pool.onMessage((device, msg) => {
  streamer.handle(device, msg);
});

// Wire incoming chat messages → router
adapter.onMessage((msg) => {
  router.handle(msg).catch((err) => {
    console.error("[gateway] Router error:", err);
  });
});

adapter.start();
console.log(`[gateway] Running — WS :${config.wsPort}`);

process.on("SIGINT", () => {
  adapter.stop();
  pool.close();
  process.exit(0);
});
```

- [ ] **Step 3: Verify compiles**

Run: `npm run build`
Expected: Clean build

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/index.ts
git commit -m "feat: wire SessionStore, SessionManager, Router into gateway"
```

---

### Task 11: End-to-End Build Verification

- [ ] **Step 1: Full build**

Run: `npm run build`
Expected: All packages compile cleanly with no errors.

- [ ] **Step 2: Verify no regressions in existing types**

Run: `npx tsc --noEmit -p packages/shared/tsconfig.json && npx tsc --noEmit -p packages/gateway/tsconfig.json && npx tsc --noEmit -p packages/agent/tsconfig.json`
Expected: No type errors across all packages.

- [ ] **Step 3: Commit if any fixes were made**

```bash
git add -A
git commit -m "fix: resolve any remaining type errors from session integration"
```
