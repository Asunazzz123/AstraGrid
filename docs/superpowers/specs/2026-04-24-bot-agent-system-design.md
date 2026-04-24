# Bot-to-Agent 多端智能体调度系统 — 设计文档

## 概述

通过 QQ / WeChat / Telegram 消息平台，远程调度 Mac / Windows 设备上的 AI 编程智能体（Claude Code CLI、Codex CLI），实现"手机上发指令，电脑上跑代码"的个人工作流。

## 架构

```
Telegram / WeChat / QQ ──→ Bot Gateway (中心调度) ──WebSocket──→ Device Agent (Mac/Win)
                                                                   ├── Claude Code CLI
                                                                   ├── Codex CLI
                                                                   └── Shell
```

- **Bot Gateway**：Node.js/TypeScript，部署在 Mac 常驻机器上，负责接收所有 bot 消息、解析指令、管理设备连接池、路由任务、流式回传响应
- **Device Agent**：Node.js/TypeScript 守护进程，运行在每台目标设备上，通过 WebSocket 连接 Gateway，接收任务并 spawn CLI 进程执行
- **WebSocket 通信**：Gateway 为 Server，Device Agent 为 Client，预共享密钥（PSK）认证

## Package 结构

monorepo（npm workspaces），三个包：

| Package | 职责 |
|---------|------|
| `@bot/shared` | 协议类型定义（`GateToDev` / `DevToGate`）、共享配置结构 |
| `@bot/gateway` | 中心调度：Bot 适配器、消息解析、设备池、路由、响应回流 |
| `@bot/agent` | 设备守护：WebSocket 客户端、CLI 执行器、文件处理 |

### 目录结构

```
bot/
├── packages/
│   ├── shared/src/
│   │   ├── protocol.ts    # 消息类型定义
│   │   └── config.ts      # 共享配置
│   ├── gateway/src/
│   │   ├── index.ts       # 入口
│   │   ├── parser.ts      # 消息解析
│   │   ├── device-pool.ts # WebSocket Server + 设备管理
│   │   ├── router.ts      # 任务路由
│   │   ├── streamer.ts    # 响应回流
│   │   └── adapters/
│   │       ├── base.ts     # BotAdapter 抽象接口
│   │       ├── telegram.ts
│   │       ├── wechat.ts
│   │       └── qq.ts
│   └── agent/src/
│       ├── index.ts       # 入口 daemon
│       ├── ws-client.ts   # WS 连接管理
│       ├── executor.ts    # CLI spawn
│       └── file-handler.ts
├── package.json
└── tsconfig.json
```

## WebSocket 消息协议

### 消息类型

```
Gateway → Device:
  exec     { id, agent, cwd, task, env?, timeout? }
  cancel   { id }
  ping     {}

Device → Gateway:
  register { device, agents[], projects[], token }
  ack      { id }
  stdout   { id, chunk }
  stderr   { id, chunk }
  exit     { id, code, signal? }
  file     { id, file: { name, mime, data(base64), size } }
  pong     {}
```

### exec 时序

```
Gateway ──exec(id, agent, cwd, task)──→ Device
Gateway ←──ack(id)───────────────────  Device    (确认接手)
Gateway ←──stdout(id, chunk)─────────  Device    (流式输出)
Gateway ←──stdout(id, chunk)─────────  Device
Gateway ←──file(id, file)────────────  Device    (可选：截图/日志)
Gateway ←──exit(id, code)────────────  Device    (任务结束)
```

- Device 收到 exec 后必须先回 `ack`，再异步执行
- 大日志不经过 stdout 流，由 Agent 写临时文件后通过 `file` 消息回传
- stdout/stderr 不做压缩

### 连接生命周期

```
DISCONNECTED → HANDSHAKE → REGISTERED → IDLE ⇄ EXECUTING
                                              → DISCONNECTED (断线)
```

- 断线后 exponential backoff 重连
- 心跳：Gateway 定时 ping，Device 回 pong，超时判定离线

## Gateway 模块

### BotAdapter 接口

所有 Bot 平台适配器实现统一接口：

```typescript
interface BotAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: IncomingMessage) => void): void;
  sendReply(chatId: string, text: string, files?: FilePayload[]): Promise<void>;
}
```

- `IncomingMessage`：`{ chatId, userId, text, platform }`
- 先实现 Telegram（telegraf），后续接入 WeChat（wechaty）、QQ（icqq）

### parser.ts

解析用户消息，提取结构化指令：

```
输入: "@bot mac:claude project=bot 修一下 login.ts"
输出: { device: "mac", agent: "claude", project: "bot", task: "修一下 login.ts" }
```

语法：`@bot <device>:<agent> [project=<name>] <task>`

### device-pool.ts

- WebSocket Server 管理
- 设备注册表：`Map<deviceName, { ws, agents[], projects[], online, lastHeartbeat }>`
- 心跳检测：30s 间隔 ping，90s 无响应判定离线
- PSK 校验：register 消息中的 token 与配置文件比对

### router.ts

- 根据 device 名 + agent 类型匹配设备
- 校验 device 在线 & 支持该 agent
- 生成 UUID 任务 ID，通过 WebSocket 发送 exec

### streamer.ts

- 接收 Device 回传的 stdout/stderr/file 消息
- stdout 实时调用 `botAdapter.sendReply()` 分片发送到聊天
- file 消息根据 mime 类型决定展示方式（图片直接发送，其他文件发送摘要+文件名）

## Device Agent 模块

### ws-client.ts

- WebSocket 连接 Gateway
- 启动时发送 `register`（device name, agents, projects, token）
- 断线自动重连（exponential backoff: 1s → 2s → 4s → ... max 60s）
- 心跳响应 `pong`

### executor.ts

- 收到 exec 后立即回 `ack`
- spawn CLI 子进程，agent 类型到命令映射：

| agent | 命令 |
|-------|------|
| claude | `claude -p "<task>" --cwd <cwd>` |
| codex | `codex exec "<task>" --cwd <cwd>` |
| shell | 直接执行 task 内容（白名单校验） |

- stdout/stderr 流式通过 WS 回传（chunk 按行分割，最大 4KB/条）
- 超时处理：默认 10 分钟，先 SIGTERM，30s 后 SIGKILL
- 收到 cancel 消息时 SIGKILL 进程

### file-handler.ts

- 提供 `readFile(filePath): FilePayload` 函数
- 读取文件 → base64 编码 → 构造 FilePayload

## 安全设计

- WebSocket 连接使用预共享 token 认证（配置文件预设，仅个人使用）
- shell agent 执行命令白名单校验（可选，后续加强）
- 关键破坏性操作（如 rm -rf）Gateway 端加确认提示
- 所有通信走本地网络 / ZeroTier 虚拟组网（不暴露公网）

## 实施阶段

### 第一阶段：核心通道（本次实现）
1. monorepo 骨架 + `@bot/shared` 协议类型
2. `@bot/gateway` 核心：device-pool、parser、router、streamer
3. `@bot/agent` 核心：ws-client、executor
4. Telegram bot 适配器
5. 端到端验证：Telegram 发消息 → Mac 执行 claude CLI → 返回结果

### 第二阶段：扩展渠道
6. WeChat 适配器
7. QQ 适配器

### 第三阶段：体验优化
8. 多轮对话会话管理
9. Windows Device Agent 支持
10. 任务队列与并发控制
