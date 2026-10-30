import type { Database } from "../../database/types.js";

export function claimTelegramUpdate(db: Database, updateId: number, telegramUserId: number | null, at: string): Promise<boolean> {
  return db.claimUpdate(updateId, telegramUserId, at);
}
