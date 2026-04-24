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
