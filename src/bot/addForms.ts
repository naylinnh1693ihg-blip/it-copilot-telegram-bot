import type { Context } from "grammy";
import type { Deps } from "../app/deps.js";
import { addFormKeyboard } from "./keyboards/menus.js";

export function httpsBaseUrl(value: string): string | null {
  const base = value.trim().replace(/\/+$/, "");
  if (!base.startsWith("https://")) return null;
  try {
    const url = new URL(base);
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** /add and the Add menu button. Web App buttons only work over HTTPS. */
export async function sendAddMenu(deps: Deps, ctx: Context): Promise<void> {
  if (ctx.chat?.type !== "private") {
    await ctx.reply("Send /add in a private chat with me. I don't open these forms in groups.");
    return;
  }
  const base = httpsBaseUrl(deps.env.PUBLIC_BASE_URL);
  if (!base) {
    await ctx.reply("Forms need an HTTPS address. Set PUBLIC_BASE_URL to your public site or a tunnel, then send /add again.");
    return;
  }
  await ctx.reply("What do you want to add?", { reply_markup: addFormKeyboard(base) });
}
