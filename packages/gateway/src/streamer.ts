import { DevToGate } from "@bot/shared";
import { BotAdapter } from "./adapters/base";

const MAX_CHUNK_LENGTH = 4000;

type TaskState = {
  chatId: string;
  adapter: BotAdapter;
  buffer: string;
};

export class Streamer {
  private tasks = new Map<string, TaskState>();

  register(taskId: string, chatId: string, adapter: BotAdapter): void {
    this.tasks.set(taskId, { chatId, adapter, buffer: "" });
  }

  handle(deviceName: string, msg: DevToGate): void {
    if (msg.type === "register" || msg.type === "pong" || msg.type === "ack") return;

    const state = this.tasks.get(msg.id);
    if (!state) return;

    if (msg.type === "stdout") {
      state.buffer += msg.chunk;
      if (state.buffer.length > MAX_CHUNK_LENGTH) {
        state.adapter.sendReply(state.chatId, state.buffer);
        state.buffer = "";
      }
    }

    if (msg.type === "stderr") {
      state.adapter.sendReply(state.chatId, `[stderr] ${msg.chunk}`);
    }

    if (msg.type === "exit") {
      if (state.buffer.length > 0) {
        state.adapter.sendReply(state.chatId, state.buffer);
        state.buffer = "";
      }
      const icon = msg.code === 0 ? "✅" : "❌";
      state.adapter.sendReply(state.chatId, `${icon} Task ${msg.id.slice(0, 8)} exited with code ${msg.code}`);
      this.tasks.delete(msg.id);
    }

    if (msg.type === "file") {
      state.adapter.sendReply(state.chatId, `📎 ${msg.file.name} (${msg.file.size} bytes, ${msg.file.mime})`);
    }
  }
}
