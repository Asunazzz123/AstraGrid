import { readFileSync } from "fs";
import { resolve } from "path";
import { GatewayConfig } from "@bot/shared";
import { DevicePool } from "./device-pool";
import { Router } from "./router";
import { Streamer } from "./streamer";
import { SessionStore } from "./session-store";
import { SessionManager } from "./session-manager";
import { BotAdapter } from "./adapters/base";
import { TelegramAdapter } from "./adapters/telegram";

const configPath = resolve(process.env.GATEWAY_CONFIG || "gateway-config.json");
let config: GatewayConfig;

try {
  config = JSON.parse(readFileSync(configPath, "utf-8"));
} catch {
  console.error(`Gateway config not found at ${configPath}. Set GATEWAY_CONFIG env or create the file.`);
  process.exit(1);
}

const pool = new DevicePool(config.wsPort, config.tokens);
const streamer = new Streamer();
const adapter: BotAdapter = new TelegramAdapter(config.telegramToken, config.proxy);
const store = new SessionStore(resolve("session-store.json"));
const sessions = new SessionManager(store, pool, adapter as TelegramAdapter);
const router = new Router(pool, sessions, adapter as TelegramAdapter, streamer);

if (config.proxy) {
  console.log(`[gateway] Using proxy: ${config.proxy}`);
}

// Wire device messages → streamer
pool.onMessage((device, msg) => {
  streamer.handle(device, msg);
});

// Wire streamer sessionId → session manager
streamer.onSessionId((taskId, sessionId) => {
  sessions.updateCliSessionId(taskId, sessionId);
});

// Wire incoming chat messages → router
adapter.onMessage((msg) => {
  router.handle(msg);
});

adapter.start().then(() => {
  console.log(`[gateway] Running — WS :${config.wsPort}, Telegram bot active`);
});

process.on("SIGINT", () => {
  adapter.stop();
  pool.close();
  process.exit(0);
});
