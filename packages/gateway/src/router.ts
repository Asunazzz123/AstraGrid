import { randomUUID } from "crypto";
import { parse, ParsedResult } from "./parser";
import { DevicePool } from "./device-pool";
import { SessionManager } from "./session-manager";
import { Streamer } from "./streamer";
import { BotAdapter, IncomingMessage } from "./adapters/base";
import { TelegramAdapter } from "./adapters/telegram";

export class Router {
  constructor(
    private pool: DevicePool,
    private sessions: SessionManager,
    private adapter: TelegramAdapter,
    private streamer: Streamer
  ) {}

  async handle(msg: IncomingMessage): Promise<void> {
    // 1. Topic message → route to session
    if (msg.topicId && msg.isTopicMessage) {
      await this.handleTopicMessage(msg);
      return;
    }

    // 2. Parse command from main chat
    const parsed = parse(msg.text);
    if (!parsed) {
      await this.adapter.sendReply(
        msg.chatId,
        [
          "Usage:",
          "  @bot <device>:<agent> @init [project=<name>] [task]",
          "  @bot <device>:<agent> [project=<name>] <task>",
          "  /kill     — end session (inside topic)",
          "  /status   — session status (inside topic)",
          "  /sessions — list sessions in this chat",
        ].join("\n")
      );
      return;
    }

    switch (parsed.type) {
      case "init":
        await this.handleInit(msg.chatId, parsed);
        break;
      case "exec":
        this.handleExec(msg.chatId, parsed);
        break;
      case "kill":
        await this.adapter.sendReply(msg.chatId, "❌ /kill must be used inside a topic.");
        break;
      case "status":
        await this.adapter.sendReply(msg.chatId, "❌ /status must be used inside a topic.");
        break;
      case "sessions":
        await this.handleList(msg.chatId);
        break;
    }
  }

  private async handleTopicMessage(msg: IncomingMessage): Promise<void> {
    const session = this.sessions.getByTopic(msg.chatId, msg.topicId!);
    if (!session) {
      await this.adapter.sendReply(msg.chatId, "No active session here. Use @bot device:agent @init in the main chat.", undefined, msg.topicId);
      return;
    }

    // Auto-recover from inactive
    if (session.state === "inactive") {
      this.sessions.setActive(session.sessionId);
    }

    const trimmed = msg.text.trim();

    // Special commands inside topic
    if (/^\/kill$/i.test(trimmed)) {
      await this.sessions.kill(session.sessionId);
      await this.adapter.sendReply(msg.chatId, `🛑 Session \`${session.sessionId.slice(0, 8)}\` killed.`, undefined, session.topicId);
      return;
    }

    if (/^\/status$/i.test(trimmed)) {
      await this.adapter.sendReply(
        msg.chatId,
        [
          `📋 Session \`${session.sessionId.slice(0, 8)}\``,
          `   Device: ${session.device}`,
          `   Agent: ${session.agent}`,
          `   Project: ${session.project || "default"}`,
          `   CWD: ${session.cwd}`,
          `   State: ${session.state}`,
          `   Created: ${new Date(session.createdAt).toISOString()}`,
        ].join("\n"),
        undefined,
        session.topicId
      );
      return;
    }

    // Route plain text to session
    const taskId = this.sessions.sendInput(
      session.sessionId,
      session.device,
      session.agent,
      session.cwd,
      trimmed
    );

    this.streamer.register(taskId, session.chatId, this.adapter as unknown as BotAdapter, session.topicId);
  }

  private async handleInit(
    chatId: string,
    parsed: ParsedResult & { type: "init" }
  ): Promise<void> {
    const dev = this.pool.getDevice(parsed.device);

    if (!dev?.online) {
      const online = this.pool.listDevices().map((d) => d.device).join(", ") || "none";
      await this.adapter.sendReply(chatId, `❌ Device "${parsed.device}" offline or not found. Online: ${online}`);
      return;
    }

    if (!dev.agents.includes(parsed.agent)) {
      await this.adapter.sendReply(chatId, `❌ Device "${parsed.device}" has no "${parsed.agent}" agent. Available: ${dev.agents.join(", ")}`);
      return;
    }

    if (parsed.agent === "shell") {
      await this.adapter.sendReply(chatId, `❌ Session mode not supported for shell agent. Use: @bot ${parsed.device}:shell <command>`);
      return;
    }

    const cwd = parsed.project
      ? dev.projects.find((p) => p === parsed.project || p.endsWith("/" + parsed.project)) ?? dev.projects[0] ?? process.cwd()
      : dev.projects[0] ?? process.cwd();

    // Create session record + Telegram topic
    const record = await this.sessions.create(chatId, parsed.device, parsed.agent, parsed.project, cwd);

    if (parsed.task) {
      // Send initial task
      const taskId = this.sessions.sendInit(
        record.sessionId,
        parsed.device,
        parsed.agent,
        cwd,
        parsed.task
      );
      this.streamer.register(taskId, chatId, this.adapter as unknown as BotAdapter, record.topicId);
    }

    const label = parsed.task
      ? `✅ Session \`${record.sessionId.slice(0, 8)}\` created. Topic: ${parsed.agent}@${parsed.device}${parsed.project ? ` · ${parsed.project}` : ""}`
      : `✅ Session \`${record.sessionId.slice(0, 8)}\` created. Send your first message in the topic.`;

    await this.adapter.sendReply(chatId, label, undefined, record.topicId);
  }

  private handleExec(
    chatId: string,
    parsed: ParsedResult & { type: "exec" }
  ): void {
    const dev = this.pool.getDevice(parsed.device);

    if (!dev?.online) {
      this.adapter.sendReply(chatId, `❌ Device "${parsed.device}" offline.`);
      return;
    }

    if (!dev.agents.includes(parsed.agent)) {
      this.adapter.sendReply(chatId, `❌ Device has no "${parsed.agent}" agent.`);
      return;
    }

    const cwd = parsed.project
      ? dev.projects.find((p) => p === parsed.project || p.endsWith("/" + parsed.project)) ?? dev.projects[0] ?? process.cwd()
      : dev.projects[0] ?? process.cwd();

    const taskId = randomUUID();
    this.pool.send(parsed.device, {
      type: "exec",
      id: taskId,
      agent: parsed.agent,
      cwd,
      task: parsed.task,
    });

    this.streamer.register(taskId, chatId, this.adapter as unknown as BotAdapter);
    this.adapter.sendReply(chatId, `🚀 Task \`${taskId.slice(0, 8)}\` dispatched to ${parsed.device}`);
  }

  private async handleList(chatId: string): Promise<void> {
    const sessions = this.sessions.listByChat(chatId);
    if (sessions.length === 0) {
      await this.adapter.sendReply(chatId, "No sessions in this chat.");
      return;
    }
    const lines = sessions.map(
      (s) => `  [${s.state === "active" ? "●" : "○"}] \`${s.sessionId.slice(0, 8)}\` — ${s.agent}@${s.device} · ${s.project || "default"} (topic ${s.topicId})`
    );
    await this.adapter.sendReply(chatId, ["Sessions:", ...lines].join("\n"));
  }
}
