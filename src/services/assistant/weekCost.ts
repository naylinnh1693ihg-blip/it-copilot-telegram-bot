import { DateTime } from "luxon";
import type { Deps } from "../../app/deps.js";
import type { UsageSlice } from "../../database/types.js";
import type { User } from "../../types/models.js";
import { costForUsage } from "../grok/prices.js";
import { toIso } from "../../utils/time.js";

/**
 * Monday 00:00 inclusive through the next Monday 00:00 exclusive,
 * in the user's timezone (APP_TIMEZONE when the user has none).
 * A request at 00:00:01 Monday starts the new week. Sunday 23:59 is still the previous week.
 */
export function localWeekBounds(now: DateTime): { from: string; until: string } {
  const monday = now.startOf("day").minus({ days: now.weekday - 1 });
  return { from: toIso(monday), until: toIso(monday.plus({ weeks: 1 })) };
}

export async function weekCostReply(deps: Deps, user: User, now: DateTime): Promise<string> {
  const bounds = localWeekBounds(now);
  const rows = await deps.db.listUsage(user.id, bounds.from, bounds.until);
  return formatWeekCost(rows);
}

export function formatWeekCost(rows: UsageSlice[]): string {
  if (rows.length === 0) return "No AI usage recorded this week.";
  const grouped = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number | null }>();
  for (const row of rows) {
    const current = grouped.get(row.model) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    const cost = costForUsage(row.model, row.inputTokens, row.outputTokens);
    current.costUsd = cost === null || current.costUsd === null ? null : current.costUsd + cost;
    grouped.set(row.model, current);
  }

  const lines = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, totals]) => {
      const tokens = `${formatTokens(totals.inputTokens)} in / ${formatTokens(totals.outputTokens)} out`;
      if (totals.costUsd === null) return `${model}: price unknown (${tokens})`;
      return `${model}: ${formatUsd(totals.costUsd)} (${tokens})`;
    });

  const known = [...grouped.values()].filter((item) => item.costUsd !== null);
  const unknown = grouped.size - known.length;
  const total = known.reduce((sum, item) => sum + (item.costUsd ?? 0), 0);
  const totalLine = known.length === 0 ? "Total: price unknown" : `Total: ${formatUsd(total)}`;
  const note = unknown > 0 && known.length > 0 ? "\nTotal excludes models with an unknown price." : "";
  return `AI cost this week:\n${totalLine}\n\n${lines.join("\n")}${note}`;
}

function formatUsd(amount: number): string {
  const cents = Math.round(amount * 100 + 1e-8);
  if (amount > 0 && cents === 0) return `$${amount.toFixed(4)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  const thousands = Math.round((count / 1000) * 10) / 10;
  return `${String(thousands).replace(/\.0$/, "")}k`;
}
