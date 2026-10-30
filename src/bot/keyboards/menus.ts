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
    .text("Summary", "m:summary");
}

export function confirmKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("Confirm", "c:yes").text("Cancel", "c:no");
}
