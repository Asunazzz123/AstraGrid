# Bot-to-Agent Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the core messaging channel — Telegram bot receives a command, Gateway routes it via WebSocket, Device Agent executes Claude Code CLI, output streams back to Telegram chat.

**Architecture:** Three npm workspace packages in monorepo. `@bot/shared` holds protocol types. `@bot/gateway` runs WebSocket server + Telegram bot adapter, parses messages, routes to devices, streams responses. `@bot/agent` runs on target devices as daemon, maintains WS connection, spawns CLI processes.

**Tech Stack:** Node.js 18+, TypeScript 5.x, `ws` (WebSocket), `telegraf` (Telegram), `tsx` (dev runner), npm workspaces

---

### Task 1: Monorepo skeleton

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `packages/shared/package.json`
- Create: `packages/gateway/package.json`
- Create: `packages/agent/package.json`

- [ ] **Step 1: Create root package.json**

Write `package.json`:
```json
{
  "name": "bot",
  "private": true,
  "workspaces": ["packages/*"],
  "scripts": {
    "build": "tsc -b",
    "dev:gateway": "tsx packages/gateway/src/index.ts",
    "dev:agent": "tsx packages/agent/src/index.ts"
  },
  "devDependencies": {
    "typescript": "^5.4.0",
    "tsx": "^4.7.0",
    "@types/node": "^20.11.0",
    "@types/ws": "^8.5.10"
  }
}
```

- [ ] **Step 2: Create root tsconfig.json**

Write `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": ".",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": true,
    "composite": true,
    "resolveJsonModule": true
  },
  "references": [
    { "path": "packages/shared" },
    { "path": "packages/gateway" },
    { "path": "packages/agent" }
  ],
  "files": []
}
```

- [ ] **Step 3: Create .gitignore**

Write `.gitignore`:
```
node_modules/
dist/
.env
*.log
.superpowers/
```

- [ ] **Step 4: Create package sub-configs**

Write `packages/shared/package.json`:
```json
{
  "name": "@bot/shared",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "types": "src/index.ts"
}
```

Write `packages/gateway/package.json`:
```json
{
  "name": "@bot/gateway",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "dependencies": {
    "@bot/shared": "*",
    "ws": "^8.16.0",
    "telegraf": "^4.15.0"
  }
}
```

Write `packages/agent/package.json`:
```json
{
  "name": "@bot/agent",
  "version": "0.1.0",
  "private": true,
  "main": "src/index.ts",
  "dependencies": {
    "@bot/shared": "*",
    "ws": "^8.16.0"
  }
}
```

Write `packages/shared/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"]
}
```

Write `packages/gateway/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../shared" }]
}
```

Write `packages/agent/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../shared" }]
}
```

- [ ] **Step 5: Install dependencies and verify**

Run: `npm install`
Expected: installs all dependencies, no errors.

Run: `npx tsc --version`
Expected: prints TypeScript version.

- [ ] **Step 6: Commit**

```bash
git add package.json tsconfig.json .gitignore packages/
git commit -m "feat: scaffold monorepo with three workspace packages

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 2: @bot/shared — protocol types

**Files:**
- Create: `packages/shared/src/protocol.ts`
- Create: `packages/shared/src/config.ts`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Write protocol.ts**

Write `packages/shared/src/protocol.ts`:
```typescript
export type AgentType = "claude" | "codex" | "shell";

export type FilePayload = {
  name: string;
  mime: string;
  data: string; // base64 encoded
  size: number; // original byte count
};

// Gateway → Device
export type GateToDev =
  | { type: "exec"; id: string; agent: AgentType; cwd: string; task: string; env?: Record<string, string>; timeout?: number }
  | { type: "cancel"; id: string }
  | { type: "ping" };

// Device → Gateway
export type DevToGate =
  | { type: "register"; device: string; agents: AgentType[]; projects: string[]; token: string }
  | { type: "ack"; id: string }
  | { type: "stdout"; id: string; chunk: string }
  | { type: "stderr"; id: string; chunk: string }
  | { type: "exit"; id: string; code: number; signal?: string }
  | { type: "file"; id: string; file: FilePayload }
  | { type: "pong" };

export function isGateToDev(msg: unknown): msg is GateToDev {
  const m = msg as GateToDev;
  return m !== null && typeof m === "object" && "type" in m
    && ["exec", "cancel", "ping"].includes(m.type);
}

export function isDevToGate(msg: unknown): msg is DevToGate {
  const m = msg as DevToGate;
  return m !== null && typeof m === "object" && "type" in m
    && ["register", "ack", "stdout", "stderr", "exit", "file", "pong"].includes(m.type);
}
```

- [ ] **Step 2: Write config.ts**

Write `packages/shared/src/config.ts`:
```typescript
import { AgentType } from "./protocol";

export type GatewayConfig = {
  wsPort: number;
  tokens: Record<string, string>; // deviceName → token
  telegramToken: string;
};

export type AgentConfig = {
  gatewayUrl: string;   // e.g. ws://localhost:9527
  device: string;       // e.g. "mac-mini"
  token: string;        // pre-shared key
  agents: AgentType[];  // e.g. ["claude", "codex", "shell"]
  projects: string[];   // project directories on this device
};
```

- [ ] **Step 3: Write index.ts barrel**

Write `packages/shared/src/index.ts`:
```typescript
export * from "./protocol";
export * from "./config";
```

- [ ] **Step 4: Verify TypeScript compiles**

Run: `npx tsc -p packages/shared/tsconfig.json --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/
git commit -m "feat: define WebSocket protocol types and config types

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 3: @bot/agent — ws-client

**Files:**
- Create: `packages/agent/src/ws-client.ts`

- [ ] **Step 1: Write ws-client.ts**

Write `packages/agent/src/ws-client.ts`:
```typescript
import WebSocket from "ws";
import { DevToGate, GateToDev } from "@bot/shared";
import { AgentConfig } from "@bot/shared";

export type Connection = {
  send: (msg: DevToGate) => void;
  close: () => void;
};

export function connect(config: AgentConfig, onMessage: (msg: GateToDev) => void): Connection {
  let ws: WebSocket;
  let retryDelay = 1000;

  function create() {
    ws = new WebSocket(config.gatewayUrl);

    ws.on("open", () => {
      retryDelay = 1000;
      const register: DevToGate = {
        type: "register",
        device: config.device,
        agents: config.agents,
        projects: config.projects,
        token: config.token,
      };
      ws.send(JSON.stringify(register));
      console.log(`[ws-client] Registered as "${config.device}"`);
    });

    ws.on("message", (raw) => {
      let msg: GateToDev;
      try {
        msg = JSON.parse(raw.toString()) as GateToDev;
      } catch {
        return;
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" } satisfies DevToGate));
        return;
      }
      onMessage(msg);
    });

    ws.on("close", () => {
      console.log(`[ws-client] Disconnected, reconnecting in ${retryDelay}ms...`);
      setTimeout(create, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    });

    ws.on("error", (err) => {
      console.error("[ws-client] Error:", err.message);
      ws.close();
    });
  }

  create();

  return {
    send: (msg: DevToGate) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close: () => ws.close(),
  };
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/agent/tsconfig.json --noEmit`
Expected: no type errors (config.ts and protocol.ts must compile first).

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/ws-client.ts
git commit -m "feat: agent WS client with auto-reconnect and heartbeat

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 4: @bot/agent — executor

**Files:**
- Create: `packages/agent/src/executor.ts`

- [ ] **Step 1: Write executor.ts**

Write `packages/agent/src/executor.ts`:
```typescript
import { spawn, ChildProcess } from "child_process";
import { GateToDev, DevToGate, AgentType } from "@bot/shared";

type ExecMsg = Extract<GateToDev, { type: "exec" }>;
export type SendFn = (msg: DevToGate) => void;

const AGENT_CMD: Record<AgentType, (cwd: string, task: string) => { cmd: string; args: string[] }> = {
  claude: (cwd, task) => ({ cmd: "claude", args: ["-p", task, "--cwd", cwd] }),
  codex: (cwd, task) => ({ cmd: "codex", args: ["exec", task, "--cwd", cwd] }),
  shell: (_cwd, task) => ({ cmd: process.env.SHELL || "/bin/sh", args: ["-c", task] }),
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min

export type TaskHandle = { cancel: () => void };

export function execute(msg: ExecMsg, send: SendFn): TaskHandle {
  const { id, agent, cwd, task, timeout: timeoutMs = DEFAULT_TIMEOUT_MS } = msg;
  const { cmd, args } = AGENT_CMD[agent](cwd, task);

  console.log(`[executor] ${id} — spawning: ${cmd} ${args.join(" ")}`);

  const proc: ChildProcess = spawn(cmd, args, {
    cwd,
    env: { ...process.env },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let cancelled = false;

  const timer = setTimeout(() => {
    if (!cancelled) {
      console.log(`[executor] ${id} — timeout, sending SIGTERM`);
      proc.kill("SIGTERM");
      setTimeout(() => {
        if (!proc.killed) {
          proc.kill("SIGKILL");
        }
      }, 30000);
    }
  }, timeoutMs);

  proc.stdout!.on("data", (chunk: Buffer) => {
    if (!cancelled) send({ type: "stdout", id, chunk: chunk.toString() });
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    if (!cancelled) send({ type: "stderr", id, chunk: chunk.toString() });
  });

  proc.on("exit", (code, signal) => {
    clearTimeout(timer);
    if (!cancelled) {
      send({ type: "exit", id, code: code ?? 1, signal: signal ?? undefined });
    }
    console.log(`[executor] ${id} — exit ${code}`);
  });

  return {
    cancel: () => {
      cancelled = true;
      clearTimeout(timer);
      proc.kill("SIGKILL");
      console.log(`[executor] ${id} — cancelled`);
    },
  };
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/agent/tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/executor.ts
git commit -m "feat: CLI executor with timeout, cancel, and stream output

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 5: @bot/agent — file-handler

**Files:**
- Create: `packages/agent/src/file-handler.ts`

- [ ] **Step 1: Write file-handler.ts**

Write `packages/agent/src/file-handler.ts`:
```typescript
import { readFileSync } from "fs";
import { basename } from "path";
import { FilePayload } from "@bot/shared";

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".json": "application/json",
  ".html": "text/html",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
};

export function readFile(filePath: string): FilePayload {
  const buf = readFileSync(filePath);
  const ext = basename(filePath).match(/\.[a-z0-9]+$/i)?.[0] ?? "";
  return {
    name: basename(filePath),
    mime: MIME_MAP[ext.toLowerCase()] ?? "application/octet-stream",
    data: buf.toString("base64"),
    size: buf.length,
  };
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/agent/tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/file-handler.ts
git commit -m "feat: file handler for base64 file payloads

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 6: @bot/agent — index (daemon entry)

**Files:**
- Create: `packages/agent/src/index.ts`

- [ ] **Step 1: Write agent index.ts**

Write `packages/agent/src/index.ts`:
```typescript
import { connect } from "./ws-client";
import { execute, TaskHandle } from "./executor";
import { AgentConfig } from "@bot/shared";
import { GateToDev } from "@bot/shared";

const config: AgentConfig = JSON.parse(process.env.AGENT_CONFIG || "{}");

if (!config.gatewayUrl || !config.device) {
  console.error("AGENT_CONFIG env var required with gatewayUrl and device");
  process.exit(1);
}

const running = new Map<string, TaskHandle>();

const conn = connect(config, (msg: GateToDev) => {
  switch (msg.type) {
    case "exec": {
      conn.send({ type: "ack", id: msg.id });
      const handle = execute(msg, (m) => conn.send(m));
      running.set(msg.id, handle);
      break;
    }
    case "cancel": {
      const handle = running.get(msg.id);
      if (handle) {
        handle.cancel();
        running.delete(msg.id);
      }
      break;
    }
  }
});

process.on("SIGINT", () => {
  console.log("\n[agent] Shutting down...");
  for (const [, h] of running) h.cancel();
  running.clear();
  conn.close();
  process.exit(0);
});

console.log(`[agent] Started — device "${config.device}" connecting to ${config.gatewayUrl}`);
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/agent/tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/agent/src/index.ts
git commit -m "feat: agent daemon entry point — connect, ack, execute, cancel

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 7: @bot/gateway — BotAdapter interface

**Files:**
- Create: `packages/gateway/src/adapters/base.ts`

- [ ] **Step 1: Write base.ts**

Write `packages/gateway/src/adapters/base.ts`:
```typescript
import { FilePayload } from "@bot/shared";

export type IncomingMessage = {
  chatId: string;
  userId: string;
  text: string;
  platform: "telegram" | "wechat" | "qq";
};

export type MessageHandler = (msg: IncomingMessage) => void;

export interface BotAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  sendReply(chatId: string, text: string, files?: FilePayload[]): Promise<void>;
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/adapters/base.ts
git commit -m "feat: BotAdapter interface for pluggable bot platforms

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 8: @bot/gateway — parser

**Files:**
- Create: `packages/gateway/src/parser.ts`

- [ ] **Step 1: Write parser.ts**

Write `packages/gateway/src/parser.ts`:
```typescript
import { AgentType } from "@bot/shared";

export type ParsedCommand = {
  device: string;
  agent: AgentType;
  project?: string;
  task: string;
};

// Syntax: @bot <device>:<agent> [project=<name>] <task>
// Example: @bot mac:claude project=bot 修一下 login.ts 的类型报错
export function parse(text: string): ParsedCommand | null {
  const match = text.match(/^@bot\s+(\w+):(\w+)(?:\s+project=(\S+))?\s+(.+)/s);
  if (!match) return null;

  const [, device, agent, project, task] = match;

  if (!["claude", "codex", "shell"].includes(agent)) return null;

  return {
    device,
    agent: agent as AgentType,
    project: project || undefined,
    task: task.trim(),
  };
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/parser.ts
git commit -m "feat: message parser — @bot device:agent [project=...] task

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 9: @bot/gateway — device-pool

**Files:**
- Create: `packages/gateway/src/device-pool.ts`

- [ ] **Step 1: Write device-pool.ts**

Write `packages/gateway/src/device-pool.ts`:
```typescript
import { WebSocketServer, WebSocket } from "ws";
import { GateToDev, DevToGate, AgentType } from "@bot/shared";

export type DeviceInfo = {
  device: string;
  agents: AgentType[];
  projects: string[];
  online: boolean;
  lastHeartbeat: number;
};

type InternalDevice = DeviceInfo & { ws: WebSocket };

export class DevicePool {
  private devices = new Map<string, InternalDevice>();
  private wss: WebSocketServer;
  private tokens: Record<string, string>;
  private listeners: Array<(device: string, msg: DevToGate) => void> = [];

  constructor(port: number, tokens: Record<string, string>) {
    this.tokens = tokens;
    this.wss = new WebSocketServer({ port });

    this.wss.on("connection", (ws) => {
      let deviceName: string | null = null;

      ws.on("message", (raw) => {
        let msg: DevToGate;
        try { msg = JSON.parse(raw.toString()) as DevToGate; } catch { return; }

        if (msg.type === "register") {
          if (this.tokens[msg.device] !== msg.token) {
            ws.close(4001, "unauthorized");
            return;
          }
          deviceName = msg.device;
          this.devices.set(msg.device, {
            ws,
            device: msg.device,
            agents: msg.agents,
            projects: msg.projects,
            online: true,
            lastHeartbeat: Date.now(),
          });
          console.log(`[device-pool] ${msg.device} registered`);
          return;
        }

        if (msg.type === "pong" && deviceName) {
          const dev = this.devices.get(deviceName);
          if (dev) {
            dev.lastHeartbeat = Date.now();
            dev.online = true;
          }
          return;
        }

        if (deviceName) {
          for (const fn of this.listeners) fn(deviceName, msg);
        }
      });

      ws.on("close", () => {
        if (deviceName) {
          const dev = this.devices.get(deviceName);
          if (dev && dev.ws === ws) {
            dev.online = false;
            console.log(`[device-pool] ${deviceName} disconnected`);
          }
        }
      });
    });

    // Heartbeat: ping every 30s, offline after 90s
    setInterval(() => {
      const now = Date.now();
      for (const [name, dev] of this.devices) {
        if (now - dev.lastHeartbeat > 90000) {
          dev.online = false;
          this.devices.delete(name);
          console.log(`[device-pool] ${name} timed out`);
        } else if (dev.online) {
          dev.ws.send(JSON.stringify({ type: "ping" } satisfies GateToDev));
        }
      }
    }, 30000);

    console.log(`[device-pool] WebSocket server listening on :${port}`);
  }

  getDevice(name: string): DeviceInfo | undefined {
    return this.devices.get(name);
  }

  listDevices(): DeviceInfo[] {
    return [...this.devices.values()].map(({ ws: _, ...info }) => info);
  }

  send(device: string, msg: GateToDev): boolean {
    const dev = this.devices.get(device);
    if (!dev?.online) return false;
    dev.ws.send(JSON.stringify(msg));
    return true;
  }

  onMessage(fn: (device: string, msg: DevToGate) => void): void {
    this.listeners.push(fn);
  }

  close(): void {
    this.wss.close();
  }
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/device-pool.ts
git commit -m "feat: device pool — WS server, register, heartbeat, token auth

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 10: @bot/gateway — router

**Files:**
- Create: `packages/gateway/src/router.ts`

- [ ] **Step 1: Write router.ts**

Write `packages/gateway/src/router.ts`:
```typescript
import { randomUUID } from "crypto";
import { ParsedCommand } from "./parser";
import { DevicePool } from "./device-pool";
import { GateToDev } from "@bot/shared";

export type RouteResult =
  | { ok: true; taskId: string; device: string }
  | { ok: false; error: string };

export function route(cmd: ParsedCommand, pool: DevicePool): RouteResult {
  const dev = pool.getDevice(cmd.device);

  if (!dev) {
    return { ok: false, error: `Device "${cmd.device}" not found. Online: ${pool.listDevices().map(d => d.device).join(", ") || "none"}` };
  }

  if (!dev.online) {
    return { ok: false, error: `Device "${cmd.device}" is offline` };
  }

  if (!dev.agents.includes(cmd.agent)) {
    return { ok: false, error: `Device "${cmd.device}" has no "${cmd.agent}" agent. Available: ${dev.agents.join(", ")}` };
  }

  const taskId = randomUUID();
  const cwd = cmd.project
    ? dev.projects.find(p => p.startsWith(cmd.project!)) ?? dev.projects[0] ?? process.cwd()
    : dev.projects[0] ?? process.cwd();

  const exec: GateToDev = {
    type: "exec",
    id: taskId,
    agent: cmd.agent,
    cwd,
    task: cmd.task,
  };

  pool.send(cmd.device, exec);

  return { ok: true, taskId, device: cmd.device };
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/router.ts
git commit -m "feat: router — match device, validate agent, send exec

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 11: @bot/gateway — streamer

**Files:**
- Create: `packages/gateway/src/streamer.ts`

- [ ] **Step 1: Write streamer.ts**

Write `packages/gateway/src/streamer.ts`:
```typescript
import { DevToGate } from "@bot/shared";
import { BotAdapter } from "./adapters/base";

const MAX_CHUNK_LENGTH = 4000; // Telegram message limit safety margin

type TaskState = {
  chatId: string;
  adapter: BotAdapter;
  buffer: string;
};

export class Streamer {
  private tasks = new Map<string, TaskState>();

  register(taskId: string, chatId: string, adapter: BotAdapter): void {
    this.tasks.set(taskId, { chatId, adapter, buffer: "" });
  }

  handle(deviceName: string, msg: DevToGate): void {
    if (msg.type === "register" || msg.type === "pong" || msg.type === "ack") return;

    const state = this.tasks.get(msg.id);
    if (!state) return;

    if (msg.type === "stdout") {
      state.buffer += msg.chunk;
      // Flush when buffer gets large enough
      if (state.buffer.length > MAX_CHUNK_LENGTH) {
        state.adapter.sendReply(state.chatId, state.buffer);
        state.buffer = "";
      }
    }

    if (msg.type === "stderr") {
      state.adapter.sendReply(state.chatId, `[stderr] ${msg.chunk}`);
    }

    if (msg.type === "exit") {
      // Flush remaining buffer
      if (state.buffer.length > 0) {
        state.adapter.sendReply(state.chatId, state.buffer);
        state.buffer = "";
      }
      const icon = msg.code === 0 ? "✅" : "❌";
      state.adapter.sendReply(state.chatId, `${icon} Task ${msg.id.slice(0, 8)} exited with code ${msg.code}`);
      this.tasks.delete(msg.id);
    }

    if (msg.type === "file") {
      state.adapter.sendReply(state.chatId, `📎 ${msg.file.name} (${msg.file.size} bytes, ${msg.file.mime})`);
    }
  }
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/streamer.ts
git commit -m "feat: streamer — buffer stdout chunks, relay to chat adapter

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 12: @bot/gateway — Telegram adapter

**Files:**
- Create: `packages/gateway/src/adapters/telegram.ts`

- [ ] **Step 1: Write telegram.ts**

Write `packages/gateway/src/adapters/telegram.ts`:
```typescript
import { Telegraf } from "telegraf";
import { BotAdapter, MessageHandler, IncomingMessage } from "./base";
import { FilePayload } from "@bot/shared";

export class TelegramAdapter implements BotAdapter {
  private bot: Telegraf;
  private handlers: MessageHandler[] = [];

  constructor(token: string) {
    this.bot = new Telegraf(token);
  }

  async start(): Promise<void> {
    this.bot.on("text", (ctx) => {
      const msg: IncomingMessage = {
        chatId: String(ctx.chat.id),
        userId: String(ctx.from?.id ?? "unknown"),
        text: ctx.message.text,
        platform: "telegram",
      };
      for (const h of this.handlers) h(msg);
    });

    await this.bot.launch();
    console.log("[telegram] Bot started");
  }

  async stop(): Promise<void> {
    this.bot.stop();
    console.log("[telegram] Bot stopped");
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async sendReply(chatId: string, text: string, _files?: FilePayload[]): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, text.slice(0, 4096));
    } catch (err) {
      console.error("[telegram] sendReply error:", err);
    }
  }
}
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/adapters/telegram.ts
git commit -m "feat: Telegram bot adapter using telegraf

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 13: @bot/gateway — index (entry point)

**Files:**
- Create: `packages/gateway/src/index.ts`

- [ ] **Step 1: Write gateway index.ts**

Write `packages/gateway/src/index.ts`:
```typescript
import { readFileSync } from "fs";
import { resolve } from "path";
import { GatewayConfig } from "@bot/shared";
import { DevicePool } from "./device-pool";
import { parse } from "./parser";
import { route } from "./router";
import { Streamer } from "./streamer";
import { BotAdapter } from "./adapters/base";
import { TelegramAdapter } from "./adapters/telegram";

const configPath = resolve(process.env.GATEWAY_CONFIG || "gateway-config.json");
let config: GatewayConfig;

try {
  config = JSON.parse(readFileSync(configPath, "utf-8"));
} catch {
  console.error(`Gateway config not found at ${configPath}. Set GATEWAY_CONFIG env or create the file.`);
  process.exit(1);
}

const pool = new DevicePool(config.wsPort, config.tokens);
const streamer = new Streamer();
const adapter: BotAdapter = new TelegramAdapter(config.telegramToken);

// Wire device messages → streamer
pool.onMessage((device, msg) => {
  streamer.handle(device, msg);
});

// Wire incoming chat messages → parse → route
adapter.onMessage((msg) => {
  const cmd = parse(msg.text);
  if (!cmd) {
    adapter.sendReply(msg.chatId, [
      'Usage: @bot <device>:<agent> [project=<name>] <task>',
      'Example: @bot mac:claude project=bot fix the login bug',
      '',
      `Devices online: ${pool.listDevices().map(d => `${d.device}[${d.agents.join(",")}]`).join(", ") || "none"}`,
    ].join("\n"));
    return;
  }

  const result = route(cmd, pool);
  if (!result.ok) {
    adapter.sendReply(msg.chatId, `❌ ${result.error}`);
    return;
  }

  streamer.register(result.taskId, msg.chatId, adapter);
  adapter.sendReply(msg.chatId, `🚀 Task ${result.taskId.slice(0, 8)} dispatched to ${result.device}:${cmd.agent}`);
});

adapter.start().then(() => {
  console.log(`[gateway] Running — WS :${config.wsPort}, Telegram bot active`);
});

process.on("SIGINT", () => {
  adapter.stop();
  pool.close();
  process.exit(0);
});
```

- [ ] **Step 2: Verify compiles**

Run: `npx tsc -p packages/gateway/tsconfig.json --noEmit`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/index.ts
git commit -m "feat: gateway entry point — wire all modules together

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 14: Configuration templates & smoke test

**Files:**
- Create: `gateway-config.example.json`
- Create: `agent-config.example.json`

- [ ] **Step 1: Create config templates**

Write `gateway-config.example.json`:
```json
{
  "wsPort": 9527,
  "tokens": {
    "mac-mini": "your-secret-token-here"
  },
  "telegramToken": "123456:your-telegram-bot-token"
}
```

Write `agent-config.example.json`:
```json
{
  "gatewayUrl": "ws://localhost:9527",
  "device": "mac-mini",
  "token": "your-secret-token-here",
  "agents": ["claude", "shell"],
  "projects": ["/Users/asuna/Asuna/study&work/git/bot"]
}
```

- [ ] **Step 2: Test agent startup with fake config**

Run: `AGENT_CONFIG='{"gatewayUrl":"ws://localhost:1","device":"test","token":"x","agents":["shell"],"projects":[]}' npx tsx packages/agent/src/index.ts`
Expected: agent starts, tries to connect, fails (connection refused), retries. Press Ctrl+C to stop.

- [ ] **Step 3: Test gateway compiles and parser works**

Run: `npx tsc -p packages/gateway/tsconfig.json --noEmit && npx tsx -e "
const { parse } = require('./packages/gateway/src/parser');
console.log(JSON.stringify(parse('@bot mac:claude project=bot fix the bug')));
console.log(JSON.stringify(parse('@bot win:codex run tests')));
console.log(JSON.stringify(parse('random chat message')));
"`
Expected: three JSON lines — two parsed commands, one null.

- [ ] **Step 4: Commit**

```bash
git add gateway-config.example.json agent-config.example.json
git commit -m "feat: add config templates and verify parser

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```

---

### Task 15: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write README**

Write `README.md`:
```markdown
# Bot → Agent 多端智能体调度

通过 Telegram 消息调度 Mac/Windows 设备上的 Claude Code / Codex CLI。

## 架构

```
Telegram → Bot Gateway (WebSocket Server) → Device Agent → CLI
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置 Gateway

```bash
cp gateway-config.example.json gateway-config.json
# 编辑 gateway-config.json，填入 Telegram Bot Token 和设备 tokens
```

### 3. 启动 Gateway

```bash
npm run dev:gateway
```

### 4. 配置并启动 Device Agent

```bash
cp agent-config.example.json agent-config.json
# 编辑 agent-config.json，填入 gateway URL 和 token
AGENT_CONFIG="$(cat agent-config.json)" npm run dev:agent
```

### 5. 在 Telegram 发送指令

```
@bot mac-mini:claude project=bot 修一下 login.ts 的类型报错
```

## 消息格式

@bot `<device>`:`<agent>` [project=`<name>`] `<task>`

- `device`: 目标设备名
- `agent`: claude | codex | shell
- `project`: 可选，指定项目目录
- `task`: 任务描述
```

- [ ] **Step 2: Final commit**

```bash
git add README.md
git commit -m "docs: add README with setup and usage instructions

Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>"
```
