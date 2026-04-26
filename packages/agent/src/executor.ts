import { spawn, ChildProcess } from "child_process";
import { writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { GateToDev, DevToGate, AgentType } from "@bot/shared";
import { readFile } from "./file-handler";

type ExecMsg = Extract<GateToDev, { type: "exec" }>;
export type SendFn = (msg: DevToGate) => void;

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min
const STDOUT_SIZE_LIMIT = 102400; // 100KB — switch to file delivery above this

function getAgentCmd(
  agent: AgentType,
  cwd: string,
  task: string,
  sessionId?: string,
  isSessionInit?: boolean
): { cmd: string; args: string[] } {
  switch (agent) {
    case "claude":
      if (sessionId && isSessionInit) {
        const shortId = sessionId.slice(0, 8);
        return { cmd: "claude", args: ["-p", "--session-id", sessionId, "--name", `tg-${shortId}`, task, "--cwd", cwd] };
      }
      if (sessionId && !isSessionInit) {
        return { cmd: "claude", args: ["-c", "-p", task, "--cwd", cwd] };
      }
      return { cmd: "claude", args: ["-p", task, "--cwd", cwd] };

    case "codex":
      if (sessionId && isSessionInit) {
        return { cmd: "codex", args: ["exec", task, "--cwd", cwd] };
      }
      if (sessionId && !isSessionInit) {
        return { cmd: "codex", args: ["exec", "resume", sessionId, task, "--cwd", cwd] };
      }
      return { cmd: "codex", args: ["exec", task, "--cwd", cwd] };

    case "shell":
      return { cmd: process.env.SHELL || "/bin/sh", args: ["-c", task] };
  }
}

function getLatestCodexSessionId(): string | undefined {
  try {
    const indexPath = join(homedir(), ".codex", "session_index.jsonl");
    if (!existsSync(indexPath)) return undefined;
    const lines = readFileSync(indexPath, "utf-8").trim().split("\n");
    const last = lines[lines.length - 1];
    if (!last) return undefined;
    const entry = JSON.parse(last);
    return entry.id as string | undefined;
  } catch {
    return undefined;
  }
}

export type TaskHandle = { cancel: () => void };

export function execute(msg: ExecMsg, send: SendFn): TaskHandle {
  const { id, agent, cwd, task, sessionId, isSessionInit, timeout: timeoutMs = DEFAULT_TIMEOUT_MS } = msg;
  const { cmd, args } = getAgentCmd(agent, cwd, task, sessionId, isSessionInit);

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
      // For codex first exec, extract the session ID from codex index
      let exitSessionId: string | undefined;
      if (agent === "codex" && isSessionInit && code === 0) {
        exitSessionId = getLatestCodexSessionId();
      }
      send({ type: "exit", id, code: code ?? 1, signal: signal ?? undefined, sessionId: exitSessionId });
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
