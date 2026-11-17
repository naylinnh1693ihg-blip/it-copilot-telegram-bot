import type { Api } from "grammy";
import type { BotCommand } from "grammy/types";
import type { AppLogger } from "../utils/logger.js";
import { redactString } from "../utils/text.js";

/**
 * The private-chat command menu. One entry per bot.command(...) in src/bot/index.ts;
 * tests/profile.test.ts fails if the two drift apart.
 */
export const BOT_COMMANDS: BotCommand[] = [
  { command: "start", description: "Start the copilot" },
  { command: "help", description: "Show examples" },
  { command: "menu", description: "Open the menu" },
  { command: "status", description: "Show system status" },
  { command: "tasks", description: "List pending tasks" },
  { command: "reminders", description: "List reminders" },
  { command: "notes", description: "List saved notes" },
  { command: "documents", description: "List saved documents" },
  { command: "remember", description: "Remember a preference or fact" },
  { command: "memories", description: "List what I remember about you" },
  { command: "forget", description: "Forget a memory by number" },
  { command: "add", description: "Add equipment, a contact, or a link" },
  { command: "admin", description: "Get a sign-in link for the admin web app" },
];

/** Groups are refused today, so the group menu stays minimal. */
export const GROUP_COMMANDS: BotCommand[] = [
  { command: "help", description: "Show examples" },
  { command: "status", description: "Show system status" },
];

/** Shown in an empty chat with the bot (up to 512 characters). */
export const BOT_DESCRIPTION =
  "Your private IT work copilot. Keep tasks and reminders, save notes and documents, and look up IPs, extensions and equipment. Only the owner can use it. Send /help to see examples.";

/** Shown on the bot's profile and in share links (up to 120 characters). */
export const BOT_SHORT_DESCRIPTION = "Private IT work copilot: tasks, reminders, notes and documents.";

type ProfileApi = Pick<
  Api,
  "getMyCommands" | "setMyCommands" | "getMyDescription" | "setMyDescription" | "getMyShortDescription" | "setMyShortDescription"
>;

function sameCommands(current: BotCommand[], wanted: BotCommand[]): boolean {
  return (
    current.length === wanted.length &&
    current.every((item, index) => item.command === wanted[index]?.command && item.description === wanted[index]?.description)
  );
}

/**
 * Sets the command menus and descriptions from code, so they never drift from the handlers.
 * Each value is read first and only written when it changed. Every failure is logged and
 * swallowed: the profile is cosmetic and must never stop the server from starting.
 */
export async function syncBotProfile(api: ProfileApi, logger: AppLogger): Promise<void> {
  const step = async (name: string, task: () => Promise<boolean>): Promise<void> => {
    try {
      if (await task()) logger.info({ event: "bot_profile_updated", field: name }, "bot profile updated");
    } catch (error) {
      logger.warn(
        { event: "bot_profile_failed", field: name, message: redactString(error instanceof Error ? error.message : "profile update failed") },
        "could not update the bot profile",
      );
    }
  };

  for (const [name, scope, commands] of [
    ["private_commands", { type: "all_private_chats" }, BOT_COMMANDS],
    ["group_commands", { type: "all_group_chats" }, GROUP_COMMANDS],
  ] as const) {
    await step(name, async () => {
      if (sameCommands(await api.getMyCommands({ scope }), commands)) return false;
      await api.setMyCommands(commands, { scope });
      return true;
    });
  }

  await step("description", async () => {
    if ((await api.getMyDescription()).description === BOT_DESCRIPTION) return false;
    await api.setMyDescription(BOT_DESCRIPTION);
    return true;
  });

  await step("short_description", async () => {
    if ((await api.getMyShortDescription()).short_description === BOT_SHORT_DESCRIPTION) return false;
    await api.setMyShortDescription(BOT_SHORT_DESCRIPTION);
    return true;
  });
}
