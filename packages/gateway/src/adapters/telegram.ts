import { Telegraf } from "telegraf";
import { BotAdapter, MessageHandler, IncomingMessage } from "./base";
import { FilePayload } from "@bot/shared";

export class TelegramAdapter implements BotAdapter {
  private bot: Telegraf;
  private handlers: MessageHandler[] = [];

  constructor(token: string, proxy?: string) {
    const opts: Record<string, unknown> = {};
    if (proxy) {
      // https-proxy-agent is ESM-only, use dynamic require
      const { HttpsProxyAgent } = require("https-proxy-agent") as {
        HttpsProxyAgent: new (url: string) => object;
      };
      opts.telegram = { agent: new HttpsProxyAgent(proxy) };
    }
    this.bot = new Telegraf(token, opts);
  }

  async start(): Promise<void> {
    this.bot.on("text", (ctx) => {
      const msg: IncomingMessage = {
        chatId: String(ctx.chat.id),
        userId: String(ctx.from?.id ?? "unknown"),
        text: ctx.message.text,
        platform: "telegram",
      };
      for (const h of this.handlers) h(msg);
    });

    await this.bot.launch();
    console.log("[telegram] Bot started");
  }

  async stop(): Promise<void> {
    this.bot.stop();
    console.log("[telegram] Bot stopped");
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  async sendReply(chatId: string, text: string, _files?: FilePayload[]): Promise<void> {
    try {
      await this.bot.telegram.sendMessage(chatId, text.slice(0, 4096));
    } catch (err) {
      console.error("[telegram] sendReply error:", err);
    }
  }
}
