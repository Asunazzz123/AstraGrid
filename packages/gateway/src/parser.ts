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
