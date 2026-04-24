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
