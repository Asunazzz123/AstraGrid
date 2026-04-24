import { readFileSync } from "fs";
import { resolve } from "path";
import { GatewayConfig } from "@bot/shared";
import { DevicePool } from "./device-pool";
import { parse } from "./parser";
import { route } from "./router";
import { Streamer } from "./streamer";
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
const adapter: BotAdapter = new TelegramAdapter(config.telegramToken);

// Wire device messages → streamer
pool.onMessage((device, msg) => {
  streamer.handle(device, msg);
});

// Wire incoming chat messages → parse → route
adapter.onMessage((msg) => {
  const cmd = parse(msg.text);
  if (!cmd) {
    adapter.sendReply(msg.chatId, [
      'Usage: @bot <device>:<agent> [project=<name>] <task>',
      'Example: @bot mac:claude project=bot fix the login bug',
      '',
      `Devices online: ${pool.listDevices().map(d => `${d.device}[${d.agents.join(",")}]`).join(", ") || "none"}`,
    ].join("\n"));
    return;
  }

  const result = route(cmd, pool);
  if (!result.ok) {
    adapter.sendReply(msg.chatId, `❌ ${result.error}`);
    return;
  }

  streamer.register(result.taskId, msg.chatId, adapter);
  adapter.sendReply(msg.chatId, `🚀 Task ${result.taskId.slice(0, 8)} dispatched to ${result.device}:${cmd.agent}`);
});

adapter.start().then(() => {
  console.log(`[gateway] Running — WS :${config.wsPort}, Telegram bot active`);
});

process.on("SIGINT", () => {
  adapter.stop();
  pool.close();
  process.exit(0);
});
