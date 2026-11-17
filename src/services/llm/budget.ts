export type Provider = "xai" | "claude";

/** 0 means no limit. */
export interface BudgetLimit {
  tokens: number;
  usd: number;
}

export interface UsageRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

export interface BudgetOptions {
  limits: Record<Provider, BudgetLimit>;
  /** A provider at or above this share of a limit stops getting work that can run elsewhere. */
  divertPercent: number;
  /** Usage rows since the start of the current budget week. */
  load: () => Promise<UsageRow[]>;
  now?: () => number;
  /** How long loaded totals are trusted. Calls made in between are added as they finish. */
  cacheMs?: number;
  /** How long a provider is avoided after a quota or rate-limit error. */
  cooldownMs?: number;
}

export interface Budget {
  /** True when new work that can run on the other provider should go there. Fails open if usage cannot be read. */
  avoid(provider: Provider): Promise<boolean>;
  /** Adds a finished call to the cached totals. */
  record(provider: Provider, tokens: number, usd: number): void;
  /** A 402 or 429 pauses the provider for the cooldown. Returns true when it started one. */
  trip(provider: Provider, status: number): boolean;
  /** Why the provider is being avoided, or null. */
  reason(provider: Provider): "quota" | "budget" | null;
  percentUsed(provider: Provider): number;
  report(): Promise<string | null>;
}

/** Claude model ids start with "claude". Everything else, including embedding model names, is xAI. */
export function providerOf(model: string): Provider {
  return model.toLowerCase().startsWith("claude") ? "claude" : "xai";
}

const NAMES: Record<Provider, string> = { xai: "Grok", claude: "Claude" };

export function providerName(provider: Provider): string {
  return NAMES[provider];
}

export function createBudget(options: BudgetOptions): Budget {
  const now = options.now ?? (() => Date.now());
  const cacheMs = options.cacheMs ?? 60_000;
  const cooldownMs = options.cooldownMs ?? 5 * 60_000;
  const totals: Record<Provider, { tokens: number; usd: number }> = {
    xai: { tokens: 0, usd: 0 },
    claude: { tokens: 0, usd: 0 },
  };
  const trippedUntil: Record<Provider, number> = { xai: 0, claude: 0 };
  let loadedAt = -Infinity;
  let loading: Promise<void> | null = null;

  async function refresh(): Promise<void> {
    try {
      const rows = await options.load();
      const next = { xai: { tokens: 0, usd: 0 }, claude: { tokens: 0, usd: 0 } };
      for (const row of rows) {
        const bucket = next[providerOf(row.model)];
        bucket.tokens += row.inputTokens + row.outputTokens;
        bucket.usd += row.estimatedUsd;
      }
      totals.xai = next.xai;
      totals.claude = next.claude;
      loadedAt = now();
    } catch {
      // Keep the last totals. A usage read failure must not stop the bot from answering.
      loadedAt = now();
    }
  }

  async function ensureFresh(): Promise<void> {
    if (now() - loadedAt < cacheMs) return;
    loading ??= refresh().finally(() => {
      loading = null;
    });
    await loading;
  }

  function percentUsed(provider: Provider): number {
    const limit = options.limits[provider];
    const shares: number[] = [];
    if (limit.tokens > 0) shares.push((totals[provider].tokens / limit.tokens) * 100);
    if (limit.usd > 0) shares.push((totals[provider].usd / limit.usd) * 100);
    return shares.length === 0 ? 0 : Math.max(...shares);
  }

  function hasLimit(provider: Provider): boolean {
    return options.limits[provider].tokens > 0 || options.limits[provider].usd > 0;
  }

  function reason(provider: Provider): "quota" | "budget" | null {
    if (now() < trippedUntil[provider]) return "quota";
    if (hasLimit(provider) && percentUsed(provider) >= options.divertPercent) return "budget";
    return null;
  }

  return {
    async avoid(provider) {
      if (hasLimit(provider)) await ensureFresh();
      return reason(provider) !== null;
    },
    record(provider, tokens, usd) {
      totals[provider].tokens += tokens;
      totals[provider].usd += usd;
    },
    trip(provider, status) {
      if (status !== 402 && status !== 429) return false;
      const wasPaused = now() < trippedUntil[provider];
      trippedUntil[provider] = now() + cooldownMs;
      return !wasPaused;
    },
    reason,
    percentUsed,
    async report() {
      const providers = (["xai", "claude"] as const).filter(hasLimit);
      if (providers.length === 0) return null;
      await ensureFresh();
      const lines = providers.map((provider) => {
        const limit = options.limits[provider];
        const parts: string[] = [];
        if (limit.tokens > 0) parts.push(`${formatCount(totals[provider].tokens)} of ${formatCount(limit.tokens)} tokens`);
        if (limit.usd > 0) parts.push(`$${totals[provider].usd.toFixed(2)} of $${limit.usd.toFixed(2)}`);
        const paused = now() < trippedUntil[provider] ? " (paused after a quota error)" : "";
        return `${NAMES[provider]}: ${parts.join(", ")} (${Math.round(percentUsed(provider))}%)${paused}`;
      });
      return `Provider budgets this week:\n${lines.join("\n")}`;
    },
  };
}

function formatCount(count: number): string {
  if (count >= 1_000_000) return `${Math.round((count / 1_000_000) * 10) / 10}M`;
  if (count >= 1_000) return `${Math.round((count / 1_000) * 10) / 10}K`;
  return String(count);
}
