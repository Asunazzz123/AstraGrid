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
