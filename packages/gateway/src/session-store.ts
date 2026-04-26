import { readFileSync, writeFileSync, existsSync } from "fs";
import { AgentType } from "@bot/shared";

export interface SessionRecord {
  sessionId: string;
  topicId: number;
  chatId: string;
  device: string;
  agent: AgentType;
  project?: string;
  cwd: string;
  state: "active" | "inactive";
  createdAt: number;
  lastActiveAt: number;
}

export class SessionStore {
  private records: SessionRecord[] = [];
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.loadFromDisk();
  }

  save(record: SessionRecord): void {
    const idx = this.records.findIndex(
      (r) => r.chatId === record.chatId && r.topicId === record.topicId
    );
    if (idx >= 0) {
      this.records[idx] = record;
    } else {
      this.records.push(record);
    }
    this.persist();
  }

  load(chatId: string, topicId: number): SessionRecord | undefined {
    return this.records.find((r) => r.chatId === chatId && r.topicId === topicId);
  }

  getBySessionId(sessionId: string): SessionRecord | undefined {
    return this.records.find((r) => r.sessionId === sessionId);
  }

  delete(chatId: string, topicId: number): boolean {
    const idx = this.records.findIndex(
      (r) => r.chatId === chatId && r.topicId === topicId
    );
    if (idx >= 0) {
      this.records.splice(idx, 1);
      this.persist();
      return true;
    }
    return false;
  }

  deleteBySessionId(sessionId: string): boolean {
    const idx = this.records.findIndex((r) => r.sessionId === sessionId);
    if (idx >= 0) {
      this.records.splice(idx, 1);
      this.persist();
      return true;
    }
    return false;
  }

  listByChat(chatId: string): SessionRecord[] {
    return this.records.filter((r) => r.chatId === chatId);
  }

  loadAll(): SessionRecord[] {
    return [...this.records];
  }

  updateState(sessionId: string, state: "active" | "inactive"): void {
    const r = this.records.find((r) => r.sessionId === sessionId);
    if (r) {
      r.state = state;
      r.lastActiveAt = Date.now();
      this.persist();
    }
  }

  updateCliSessionId(oldSessionId: string, newSessionId: string): void {
    const r = this.records.find((r) => r.sessionId === oldSessionId);
    if (r) {
      r.sessionId = newSessionId;
      this.persist();
    }
  }

  private persist(): void {
    writeFileSync(this.filePath, JSON.stringify(this.records, null, 2));
  }

  private loadFromDisk(): void {
    try {
      if (existsSync(this.filePath)) {
        const data = readFileSync(this.filePath, "utf-8");
        this.records = JSON.parse(data);
      }
    } catch {
      console.warn("[session-store] Failed to load, starting with empty store");
      this.records = [];
    }
  }
}
