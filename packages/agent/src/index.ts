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
