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
