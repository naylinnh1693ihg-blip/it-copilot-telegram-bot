import { DateTime } from "luxon";
import type { Deps } from "../../app/deps.js";
import { localWeekBounds } from "../assistant/weekCost.js";
import { costForUsage } from "../grok/prices.js";
import { toIso } from "../../utils/time.js";

export type UsageRange = "week" | "month";

export function monthBounds(now: DateTime): { from: string; until: string } {
  const start = now.startOf("month");
  return { from: toIso(start), until: toIso(start.plus({ months: 1 })) };
}

export function boundsForRange(now: DateTime, range: UsageRange): { from: string; until: string } {
  return range === "week" ? localWeekBounds(now) : monthBounds(now);
}

export interface UsageLine {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
}

export interface UsageEvent {
  model: string;
  purpose: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
  createdAt: string;
}

export interface UsageSummary {
  range: UsageRange;
  from: string;
  until: string;
  totalUsd: number | null;
  byModel: UsageLine[];
  events: UsageEvent[];
}

export async function buildUsageSummary(deps: Deps, userId: string, range: UsageRange): Promise<UsageSummary> {
  const bounds = boundsForRange(deps.clock.now(), range);
  const slices = await deps.db.listUsage(userId, bounds.from, bounds.until);
  const grouped = new Map<string, { inputTokens: number; outputTokens: number; costUsd: number | null }>();
  for (const row of slices) {
    const current = grouped.get(row.model) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 };
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    const cost = costForUsage(row.model, row.inputTokens, row.outputTokens);
    current.costUsd = cost === null || current.costUsd === null ? null : current.costUsd + cost;
    grouped.set(row.model, current);
  }
  const byModel = [...grouped.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([model, totals]) => ({
      model,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      costUsd: totals.costUsd,
    }));
  const known = byModel.filter((line) => line.costUsd !== null);
  const totalUsd = known.length === 0 ? (byModel.length === 0 ? null : null) : known.reduce((sum, line) => sum + (line.costUsd ?? 0), 0);
  const events = await deps.db.listUsageEvents(userId, bounds.from, bounds.until);
  return { range, from: bounds.from, until: bounds.until, totalUsd, byModel, events };
}

export function formatUsd(amount: number | null): string {
  if (amount === null) return "—";
  const cents = Math.round(amount * 100 + 1e-8);
  if (amount > 0 && cents === 0) return `$${amount.toFixed(4)}`;
  return `$${(cents / 100).toFixed(2)}`;
}
