import { createHmac } from "node:crypto";
import { secretsMatch } from "../../utils/security.js";

const MAX_AGE_SECONDS = 60 * 60;

export type InitDataResult =
  | { ok: true; telegramUserId: number; authDate: number }
  | { ok: false; status: 401; error: string };

const INVALID = "This Telegram session is not valid. Close the form and open it again from the bot.";
const EXPIRED = "This Telegram session has expired. Close the form and open it again from the bot.";

/**
 * Telegram Mini App initData. The key is HMAC-SHA256("WebAppData", bot token).
 * https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 */
export function validateInitData(initData: string, botToken: string, nowSeconds: number): InitDataResult {
  if (!botToken || !initData.trim()) return { ok: false, status: 401, error: INVALID };
  const params = new URLSearchParams(initData);
  const hash = params.get("hash") ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, status: 401, error: INVALID };
  const pairs = [...params.entries()].filter(([key]) => key !== "hash");
  const dataCheck = pairs
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const computed = createHmac("sha256", secret).update(dataCheck).digest("hex");
  if (!secretsMatch(computed, hash.toLowerCase())) return { ok: false, status: 401, error: INVALID };
  const authDate = Number(params.get("auth_date"));
  if (!Number.isInteger(authDate)) return { ok: false, status: 401, error: INVALID };
  if (authDate > nowSeconds + 60 || nowSeconds - authDate > MAX_AGE_SECONDS) {
    return { ok: false, status: 401, error: EXPIRED };
  }
  const userRaw = params.get("user");
  if (!userRaw) return { ok: false, status: 401, error: INVALID };
  let userId = Number.NaN;
  try {
    const user = JSON.parse(userRaw) as { id?: unknown };
    userId = typeof user.id === "number" ? user.id : Number.NaN;
  } catch {
    return { ok: false, status: 401, error: INVALID };
  }
  if (!Number.isInteger(userId) || userId <= 0) return { ok: false, status: 401, error: INVALID };
  return { ok: true, telegramUserId: userId, authDate };
}
