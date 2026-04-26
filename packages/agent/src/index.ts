import { existsSync, readdirSync, unlinkSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { connect } from "./ws-client";
import { execute, TaskHandle } from "./executor";
import { AgentConfig } from "@bot/shared";
import { GateToDev } from "@bot/shared";

const config: AgentConfig = JSON.parse(process.env.AGENT_CONFIG || "{}");

if (!config.gatewayUrl || !config.device) {
  console.error("AGENT_CONFIG env var required with gatewayUrl and device");
  process.exit(1);
}

const running = new Map<string, TaskHandle>();

const conn = connect(config, (msg: GateToDev) => {
  switch (msg.type) {
    case "exec": {
      if (!msg.id || !msg.agent || !msg.cwd || !msg.task) {
        console.error("[agent] Malformed exec message, dropping:", msg);
        return;
      }
      conn.send({ type: "ack", id: msg.id });
      const handle = execute(msg, (m) => conn.send(m));
      running.set(msg.id, handle);
      break;
    }
    case "cancel": {
      const handle = running.get(msg.id);
      if (handle) {
        handle.cancel();
        running.delete(msg.id);
      }
      break;
    }
    case "session_kill": {
      console.log(`[agent] Session ${msg.sessionId} kill requested — cleaning up`);
      try {
        const claudeDir = join(homedir(), ".claude", "projects");
        if (existsSync(claudeDir)) {
          const dirs = readdirSync(claudeDir);
          for (const dir of dirs) {
            const sessionFile = join(claudeDir, dir, `${msg.sessionId}.jsonl`);
            if (existsSync(sessionFile)) {
              unlinkSync(sessionFile);
              console.log(`[agent] Deleted claude session file: ${sessionFile}`);
            }
          }
        }
      } catch { /* ignore */ }
      try {
        const codexSessionsDir = join(homedir(), ".codex", "sessions");
        if (existsSync(codexSessionsDir)) {
          const years = readdirSync(codexSessionsDir);
          for (const year of years) {
            const sessionFile = join(codexSessionsDir, year, `${msg.sessionId}.jsonl`);
            if (existsSync(sessionFile)) {
              unlinkSync(sessionFile);
              console.log(`[agent] Deleted codex session file: ${sessionFile}`);
            }
          }
        }
      } catch { /* ignore */ }
      break;
    }
  }
});

process.on("SIGINT", () => {
  console.log("\n[agent] Shutting down...");
  for (const [, h] of running) h.cancel();
  running.clear();
  conn.close();
  process.exit(0);
});

console.log(`[agent] Started — device "${config.device}" connecting to ${config.gatewayUrl}`);
