import { currentChat, isGroupChat } from "../../app/chatContext.js";
import type { ReminderKind } from "../../types/models.js";

/**
 * Where a new reminder is delivered. Created in the team group: back to that group and
 * forum topic, where the member asked for it. Otherwise: the user's private chat.
 * A daily summary lists someone's tasks and reminders, so it always goes to the private chat.
 */
export function reminderDelivery(kind: ReminderKind): { deliveryChatId?: number; deliveryThreadId?: number | null } {
  const chat = currentChat();
  if (!chat || !isGroupChat(chat) || kind === "daily_summary") return {};
  return { deliveryChatId: chat.chatId, deliveryThreadId: chat.threadId ?? null };
}
