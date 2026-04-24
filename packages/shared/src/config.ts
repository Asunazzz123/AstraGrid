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
