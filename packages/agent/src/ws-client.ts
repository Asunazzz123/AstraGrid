import WebSocket from "ws";
import { DevToGate, GateToDev, isGateToDev } from "@bot/shared";
import type { AgentConfig } from "@bot/shared";

export type Connection = {
  send: (msg: DevToGate) => void;
  close: () => void;
};

export function connect(config: AgentConfig, onMessage: (msg: GateToDev) => void): Connection {
  let ws: WebSocket;
  let retryDelay = 1000;
  let stopped = false;

  function create() {
    ws = new WebSocket(config.gatewayUrl);

    ws.on("open", () => {
      retryDelay = 1000;
      const register: DevToGate = {
        type: "register",
        device: config.device,
        agents: config.agents,
        projects: config.projects,
        token: config.token,
      };
      ws.send(JSON.stringify(register));
      console.log(`[ws-client] Registered as "${config.device}"`);
    });

    ws.on("message", (raw) => {
      let msg: GateToDev;
      try {
        const parsed = JSON.parse(raw.toString());
        if (!isGateToDev(parsed)) return;
        msg = parsed;
      } catch {
        return;
      }
      if (msg.type === "ping") {
        ws.send(JSON.stringify({ type: "pong" } satisfies DevToGate));
        return;
      }
      onMessage(msg);
    });

    ws.on("close", () => {
      if (stopped) return;
      console.log(`[ws-client] Disconnected, reconnecting in ${retryDelay}ms...`);
      setTimeout(create, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 60000);
    });

    ws.on("error", (err) => {
      console.error("[ws-client] Error:", err.message);
      ws.close();
    });
  }

  create();

  return {
    send: (msg: DevToGate) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    },
    close: () => {
      stopped = true;
      ws.close();
    },
  };
}
