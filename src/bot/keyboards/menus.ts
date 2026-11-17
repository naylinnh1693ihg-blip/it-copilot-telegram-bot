import { InlineKeyboard } from "grammy";

export function mainMenu(): InlineKeyboard {
  return new InlineKeyboard()
    .text("Today's tasks", "m:today")
    .text("Pending", "m:pending")
    .row()
    .text("Reminders", "m:reminders")
    .text("Notes", "m:notes")
    .row()
    .text("Documents", "m:docs")
    .text("Summary", "m:summary")
    .row()
    .text("Add", "m:add");
}

/** Three Mini App buttons. `baseUrl` must already be https. */
export function addFormKeyboard(baseUrl: string): InlineKeyboard {
  return new InlineKeyboard()
    .webApp("Equipment", `${baseUrl}/miniapp/equipment`)
    .row()
    .webApp("Contact", `${baseUrl}/miniapp/contact`)
    .row()
    .webApp("Website link", `${baseUrl}/miniapp/link`);
}

export function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Confirm", "c:yes").text("Cancel", "c:no");
}

/** One copy_text button per row. Telegram copies `text` to the clipboard when tapped. */
export function copyKeyboard(buttons: Array<{ label: string; text: string }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  buttons.forEach((button, index) => {
    if (index > 0) keyboard.row();
    keyboard.copyText(button.label, button.text);
  });
  return keyboard;
}

/**
 * The keyboard for a reply: copy buttons first, then the menu or confirm buttons.
 * Undefined when the reply has neither.
 */
export function replyKeyboard(reply: { keyboard?: "menu" | "confirm"; copyButtons?: Array<{ label: string; text: string }> }): InlineKeyboard | undefined {
  const base = reply.keyboard === "menu" ? mainMenu() : reply.keyboard === "confirm" ? confirmKeyboard() : undefined;
  if (!reply.copyButtons?.length) return base;
  const keyboard = copyKeyboard(reply.copyButtons);
  return base ? keyboard.append(base) : keyboard;
}

export function inlineButtons(buttons: Array<{ label: string; data: string }>): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  for (const button of buttons) keyboard.text(button.label, button.data);
  return keyboard;
}
