import { randomUUID } from "crypto";
import { SessionStore, SessionRecord } from "./session-store";
import { DevicePool } from "./device-pool";
import { TelegramAdapter } from "./adapters/telegram";
import { AgentType } from "@bot/shared";

export class SessionManager {
  private store: SessionStore;
  private pool: DevicePool;
  private adapter: TelegramAdapter;
  private taskToSession = new Map<string, string>();   // taskId → logical sessionId
  private queues = new Map<string, Promise<void>>();    // sessionId → queue promise

  constructor(store: SessionStore, pool: DevicePool, adapter: TelegramAdapter) {
    this.store = store;
    this.pool = pool;
    this.adapter = adapter;
    // On startup, mark all sessions as inactive (conservative)
    for (const r of this.store.loadAll()) {
      this.store.updateState(r.sessionId, "inactive");
    }
  }

  /** Create a session record and Telegram topic. Does NOT send exec. */
  async create(
    chatId: string,
    device: string,
    agent: AgentType,
    project: string | undefined,
    cwd: string
  ): Promise<SessionRecord> {
    const sessionId = randomUUID();
    const topicName = `${agent}@${device}${project ? ` · ${project}` : ""}`;
    const topicId = await this.adapter.createForumTopic(chatId, topicName);

    const record: SessionRecord = {
      sessionId,
      topicId,
      chatId,
      device,
      agent,
      project,
      cwd,
      state: "active",
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
    };

    this.store.save(record);
    return record;
  }

  /** Send an input message to an existing session (spawns resume process). */
  sendInput(
    sessionId: string,
    device: string,
    agent: AgentType,
    cwd: string,
    task: string
  ): string {
    const taskId = randomUUID();
    this.taskToSession.set(taskId, sessionId);
    this.pool.send(device, {
      type: "exec",
      id: taskId,
      agent,
      cwd,
      task,
      sessionId,
      isSessionInit: false,
    });
    return taskId;
  }

  /** Send the first message to a brand-new session (spawns init process). */
  sendInit(
    sessionId: string,
    device: string,
    agent: AgentType,
    cwd: string,
    task: string
  ): string {
    const taskId = randomUUID();
    this.taskToSession.set(taskId, sessionId);
    this.pool.send(device, {
      type: "exec",
      id: taskId,
      agent,
      cwd,
      task,
      sessionId,
      isSessionInit: true,
    });
    return taskId;
  }

  /** Enqueue a blocking operation for a session (serial execution, P2 wiring). */
  enqueue(sessionId: string, fn: () => Promise<void>): void {
    const prev = this.queues.get(sessionId) || Promise.resolve();
    const next = prev.then(fn, fn); // run fn even if previous rejected
    this.queues.set(sessionId, next);
  }

  getByTopic(chatId: string, topicId: number): SessionRecord | undefined {
    return this.store.load(chatId, topicId);
  }

  listByChat(chatId: string): SessionRecord[] {
    return this.store.listByChat(chatId);
  }

  setActive(sessionId: string): void {
    this.store.updateState(sessionId, "active");
  }

  setInactive(sessionId: string): void {
    this.store.updateState(sessionId, "inactive");
  }

  async kill(sessionId: string): Promise<void> {
    const record = this.store.getBySessionId(sessionId);
    if (!record) return;

    try {
      await this.adapter.deleteForumTopic(record.chatId, record.topicId);
    } catch {
      // Topic may already be deleted
    }

    // Notify agent to clean up session files (best-effort)
    this.pool.send(record.device, {
      type: "session_kill",
      sessionId,
    });

    this.store.deleteBySessionId(sessionId);
    this.queues.delete(sessionId);
  }

  /** Called when exit message carries a codex sessionId — update the mapping. */
  updateCliSessionId(taskId: string, cliSessionId: string): void {
    const logicalId = this.taskToSession.get(taskId);
    if (!logicalId) return;
    this.taskToSession.delete(taskId);
    this.store.updateCliSessionId(logicalId, cliSessionId);
  }
}
