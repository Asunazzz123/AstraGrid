import { AgentType } from "./protocol";

export type GatewayConfig = {
  wsPort: number;
  tokens: Record<string, string>; // deviceName → token
  telegramToken: string;
  proxy?: string; // e.g. "http://127.0.0.1:7890" for Telegram API
};

export type AgentConfig = {
  gatewayUrl: string;   // e.g. ws://localhost:9527
  device: string;       // e.g. "mac-mini"
  token: string;        // pre-shared key
  agents: AgentType[];  // e.g. ["claude", "codex", "shell"]
  projects: string[];   // project directories on this device
};
