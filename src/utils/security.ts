import { timingSafeEqual } from "node:crypto";

export type AuthDecision =
  | { ok: true }
  | { ok: false; reason: "unconfigured" | "unauthorized" | "not_private"; message: string };

/**
 * Who may use the bot, and where. The owner and listed team members may use it in a
 * private chat. In the team group (teamChatId only), the same people may use it. Every
 * other group is refused. Records are always the sender's own; see the TODO on sharing.
 */
export function authorize(input: {
  ownerId: string;
  teamIds?: readonly string[];
  teamChatId?: string;
  fromId: number | undefined;
  chatType: string | undefined;
  chatId?: number;
}): AuthDecision {
  if (!input.ownerId) {
    return {
      ok: false,
      reason: "unconfigured",
      message: "This copilot is not ready yet. The owner has not been configured, so I will not show or save any information.",
    };
  }
  const sender = input.fromId ? String(input.fromId) : "";
  const member = sender !== "" && (sender === input.ownerId || (input.teamIds ?? []).includes(sender));
  if (!member) {
    return {
      ok: false,
      reason: "unauthorized",
      message: "This is a private bot. I can't help from this account.",
    };
  }
  const teamGroup =
    (input.chatType === "group" || input.chatType === "supergroup") &&
    !!input.teamChatId &&
    input.chatId !== undefined &&
    String(input.chatId) === input.teamChatId;
  if (input.chatType !== "private" && !teamGroup) {
    return {
      ok: false,
      reason: "not_private",
      message: "Please message me in a private chat. I don't share IT records in groups.",
    };
  }
  return { ok: true };
}

export function secretsMatch(provided: string | undefined, expected: string): boolean {
  if (!expected || !provided) return false;
  const left = Buffer.from(provided);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function createRateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return {
    allow(key: string, now: number): boolean {
      const recent = (hits.get(key) ?? []).filter((stamp) => now - stamp < windowMs);
      if (recent.length >= limit) {
        hits.set(key, recent);
        return false;
      }
      recent.push(now);
      hits.set(key, recent);
      return true;
    },
  };
}

export function wrapUntrusted(label: string, content: string): string {
  return `<untrusted_${label}>\n${content}\n</untrusted_${label}>`;
}

export function introducedNetworkFacts(source: string, polished: string): string[] {
  const found = polished.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) ?? [];
  return found.filter((ip) => !source.includes(ip));
}
