import "dotenv/config";
import { Bot } from "grammy";

async function main(): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Set TELEGRAM_BOT_TOKEN in .env before clearing the webhook.");
  const removed = await new Bot(token).api.deleteWebhook();
  if (!removed) throw new Error("Telegram did not confirm webhook removal.");
  console.log("Telegram webhook removed.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Could not remove the Telegram webhook.");
  process.exitCode = 1;
});
