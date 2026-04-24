import { spawn, ChildProcess } from "child_process";
import { writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { GateToDev, DevToGate, AgentType } from "@bot/shared";
import { readFile } from "./file-handler";

type ExecMsg = Extract<GateToDev, { type: "exec" }>;
export type SendFn = (msg: DevToGate) => void;

const AGENT_CMD: Record<AgentType, (cwd: string, task: string) => { cmd: string; args: string[] }> = {
  claude: (cwd, task) => ({ cmd: "claude", args: ["-p", task, "--cwd", cwd] }),
  codex: (cwd, task) => ({ cmd: "codex", args: ["exec", task, "--cwd", cwd] }),
  shell: (_cwd, task) => ({ cmd: process.env.SHELL || "/bin/sh", args: ["-c", task] }),
};

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const STDOUT_SIZE_LIMIT = 102400; // 100KB — switch to file delivery above this

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
  let stdoutTotal = "";
  let stderrTotal = "";
  let stdoutOverflow = false;

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
    if (cancelled) return;
    const text = chunk.toString();
    stdoutTotal += text;
    if (stdoutTotal.length > STDOUT_SIZE_LIMIT) {
      if (!stdoutOverflow) {
        stdoutOverflow = true;
        console.log(`[executor] ${id} — stdout exceeded ${STDOUT_SIZE_LIMIT} chars, switching to file delivery`);
      }
    }
    if (!stdoutOverflow) {
      send({ type: "stdout", id, chunk: text });
    }
  });

  proc.stderr!.on("data", (chunk: Buffer) => {
    if (cancelled) return;
    const text = chunk.toString();
    stderrTotal += text;
    send({ type: "stderr", id, chunk: text });
  });

  proc.on("exit", (code, signal) => {
    clearTimeout(timer);
    if (!cancelled) {
      // Deliver oversized stdout as a file
      if (stdoutOverflow) {
        const filePath = join(tmpdir(), `task-${id}-stdout.log`);
        writeFileSync(filePath, stdoutTotal);
        send({ type: "file", id, file: readFile(filePath) });
      }
      // Deliver stderr as a file on non-zero exit
      if (code !== 0 && stderrTotal.length > 0) {
        const filePath = join(tmpdir(), `task-${id}-stderr.log`);
        writeFileSync(filePath, stderrTotal);
        send({ type: "file", id, file: readFile(filePath) });
      }
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
