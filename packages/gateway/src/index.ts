import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { GatewayConfig } from "@bot/shared";
import { DevicePool } from "./device-pool";
import { Router } from "./router";
import { Streamer } from "./streamer";
import { SessionStore } from "./session-store";
import { SessionManager } from "./session-manager";
import { TelegramAdapter } from "./adapters/telegram";

const configPath = resolve(process.env.GATEWAY_CONFIG || "gateway-config.json");
let config: GatewayConfig;

try {
  config = JSON.parse(readFileSync(configPath, "utf-8"));
} catch {
  console.error(`Gateway config not found at ${configPath}. Set GATEWAY_CONFIG env or create the file.`);
  process.exit(1);
}

if (config.proxy) {
  console.log(`[gateway] Using proxy: ${config.proxy}`);
}

const pool = new DevicePool(config.wsPort, config.tokens);
const adapter = new TelegramAdapter(config.telegramToken, config.proxy);
const streamer = new Streamer();

// Session persistence file next to config
const sessionsPath = resolve(dirname(configPath), "gateway-sessions.json");
const store = new SessionStore(sessionsPath);
const sessions = new SessionManager(store, pool, adapter);

// Wire codex session ID capture: when an exit message carries a codex sessionId,
// update the session record mapping
streamer.onSessionId((taskId, codexSessionId) => {
  sessions.updateCliSessionId(taskId, codexSessionId);
});

const router = new Router(pool, sessions, adapter, streamer);

// Wire device messages → streamer
pool.onMessage((device, msg) => {
  streamer.handle(device, msg);
});

// Wire incoming chat messages → router
adapter.onMessage((msg) => {
  router.handle(msg).catch((err) => {
    console.error("[gateway] Router error:", err);
  });
});

adapter.start();
console.log(`[gateway] Running — WS :${config.wsPort}`);

process.on("SIGINT", () => {
  adapter.stop();
  pool.close();
  process.exit(0);
});
