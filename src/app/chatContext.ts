import { AsyncLocalStorage } from "node:async_hooks";

/** The chat an update came from. Set by the bot middleware for the whole handler. */
export interface ChatContext {
  chatId: number;
  chatType: string;
  /** Forum topic, when the message was sent in one. */
  threadId?: number;
}

const ambient = new AsyncLocalStorage<ChatContext>();

export function withChatContext<T>(chat: ChatContext, task: () => Promise<T>): Promise<T> {
  return ambient.run(chat, task);
}

export function currentChat(): ChatContext | undefined {
  return ambient.getStore();
}

export function isGroupChat(chat: ChatContext | undefined): boolean {
  return chat?.chatType === "group" || chat?.chatType === "supergroup";
}
