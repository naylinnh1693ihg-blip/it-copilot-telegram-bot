import type { Env } from "../config/env.js";
import type { AppLogger } from "../utils/logger.js";
import { webhookOptions } from "./index.js";

type WebhookApi = {
  getWebhookInfo(): Promise<{ url?: string }>;
  setWebhook(url: string, options: ReturnType<typeof webhookOptions>): Promise<unknown>;
};

export function webhookEndpoint(publicBaseUrl: string): string {
  return `${publicBaseUrl.replace(/\/+$/, "")}/telegram/webhook`;
}

/**
 * Registers the webhook when Telegram has a different URL, including none.
 * Long polling calls deleteWebhook, so a local poller can leave the live bot silent.
 */
export async function ensureWebhook(api: WebhookApi, env: Pick<Env, "PUBLIC_BASE_URL" | "TELEGRAM_WEBHOOK_SECRET" | "TELEGRAM_WEBHOOK_MAX_CONNECTIONS">, logger: AppLogger): Promise<"ok" | "restored"> {
  const endpoint = webhookEndpoint(env.PUBLIC_BASE_URL);
  const info = await api.getWebhookInfo();
  if (info.url === endpoint) return "ok";
  await api.setWebhook(endpoint, webhookOptions(env));
  logger.warn({ event: "webhook_restored", endpoint }, "telegram webhook was missing or pointed elsewhere, so it was registered again");
  return "restored";
}
