import { FilePayload } from "@bot/shared";

export type IncomingMessage = {
  chatId: string;
  userId: string;
  text: string;
  platform: "telegram" | "wechat" | "qq";
  topicId?: number;
  isTopicMessage?: boolean;
};

export type MessageHandler = (msg: IncomingMessage) => void;

export interface BotAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  sendReply(chatId: string, text: string, files?: FilePayload[]): Promise<void>;
}
