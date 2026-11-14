import { createHmac, randomBytes } from "node:crypto";
import type { Deps } from "../../app/deps.js";
import { adminAppEnabled } from "../../config/env.js";
import type { AdminSession, User, UserRole } from "../../types/models.js";
import { secretsMatch } from "../../utils/security.js";
import { toIso } from "../../utils/time.js";

export const LOGIN_TOKEN_MINUTES = 10;
export const SESSION_DAYS = 7;
/** Sliding expiry is written at most this often, so every request does not cost a database write. */
const TOUCH_INTERVAL_MINUTES = 15;

const ADMIN_ROLES: readonly UserRole[] = ["owner", "admin"];

export function canUseAdmin(user: User): boolean {
  return ADMIN_ROLES.includes(user.role);
}

/** HMAC-SHA256 keyed with ADMIN_SESSION_SECRET. A leaked table alone cannot be turned back into working tokens. */
export function hashSecret(deps: Deps, purpose: "login" | "session" | "csrf", value: string): string {
  if (deps.env.ADMIN_SESSION_SECRET.length < 32) throw new Error("ADMIN_SESSION_SECRET is not configured.");
  return createHmac("sha256", deps.env.ADMIN_SESSION_SECRET).update(`${purpose}:${value}`).digest("hex");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The configured owner always has the owner role. Nobody else is promoted here. */
export async function ensureOwnerRole(deps: Deps, user: User): Promise<User> {
  if (!deps.env.TELEGRAM_OWNER_ID || String(user.telegramUserId) !== deps.env.TELEGRAM_OWNER_ID) return user;
  if (user.role === "owner") return user;
  await deps.db.setUserRole(user.id, "owner");
  return { ...user, role: "owner" };
}

export function adminBaseUrl(deps: Deps): string {
  const configured = deps.env.PUBLIC_BASE_URL.trim().replace(/\/+$/, "");
  return configured || `http://localhost:${deps.env.PORT}`;
}

export type LoginLinkResult = { ok: true; url: string; expiresAt: string } | { ok: false; message: string };

/** Creates a single-use sign-in link. The token travels in the URL fragment, so it is not sent in requests or logs. */
export async function issueLoginLink(deps: Deps, input: User): Promise<LoginLinkResult> {
  if (!adminAppEnabled(deps.env)) return { ok: false, message: "The admin app is turned off." };
  const user = await ensureOwnerRole(deps, input);
  if (!canUseAdmin(user)) return { ok: false, message: "This account can't open the admin app." };
  const token = randomToken();
  const now = deps.clock.now();
  const expiresAt = toIso(now.plus({ minutes: LOGIN_TOKEN_MINUTES }));
  await deps.db.insertAdminLoginToken({
    userId: user.id,
    tokenHash: hashSecret(deps, "login", token),
    createdAt: toIso(now),
    expiresAt,
  });
  await deps.db.writeAudit({
    userId: user.id,
    action: "admin_link_issued",
    entity: "admin_login_token",
    entityId: null,
    metadata: {},
    createdAt: toIso(now),
  });
  return { ok: true, url: `${adminBaseUrl(deps)}/admin/login#token=${token}`, expiresAt };
}

export interface NewSession {
  sessionId: string;
  csrfToken: string;
  user: User;
  session: AdminSession;
}

/** Exchanges a sign-in token for a session. The token is spent even if the user turns out not to be allowed. */
export async function redeemLoginToken(deps: Deps, token: string, userAgent: string | null): Promise<NewSession | null> {
  if (!/^[A-Za-z0-9_-]{20,128}$/.test(token)) return null;
  const now = deps.clock.now();
  const userId = await deps.db.consumeAdminLoginToken(hashSecret(deps, "login", token), toIso(now));
  if (!userId) return null;
  const found = await deps.db.findUserById(userId);
  if (!found) return null;
  const user = await ensureOwnerRole(deps, found);
  if (!canUseAdmin(user)) return null;
  const sessionId = randomToken();
  const session = await deps.db.insertAdminSession({
    userId: user.id,
    sessionHash: hashSecret(deps, "session", sessionId),
    userAgent: userAgent ? userAgent.slice(0, 300) : null,
    createdAt: toIso(now),
    expiresAt: toIso(now.plus({ days: SESSION_DAYS })),
  });
  await deps.db.writeAudit({
    userId: user.id,
    action: "admin_login",
    entity: "admin_session",
    entityId: session.id,
    metadata: { method: "magic_link" },
    createdAt: toIso(now),
  });
  return { sessionId, csrfToken: csrfTokenFor(deps, sessionId), user, session };
}

export interface ActiveSession {
  session: AdminSession;
  user: User;
}

/** Looks up a session cookie and slides its expiry forward. Returns null for anything unknown, expired, or revoked. */
export async function authenticate(deps: Deps, sessionId: string | undefined): Promise<ActiveSession | null> {
  if (!sessionId || !/^[A-Za-z0-9_-]{20,128}$/.test(sessionId)) return null;
  const now = deps.clock.now();
  const session = await deps.db.findAdminSession(hashSecret(deps, "session", sessionId), toIso(now));
  if (!session) return null;
  const found = await deps.db.findUserById(session.userId);
  if (!found) return null;
  const user = await ensureOwnerRole(deps, found);
  if (!canUseAdmin(user)) return null;
  const lastSeen = Date.parse(session.lastSeenAt);
  if (Number.isNaN(lastSeen) || now.toMillis() - lastSeen >= TOUCH_INTERVAL_MINUTES * 60_000) {
    const expiresAt = toIso(now.plus({ days: SESSION_DAYS }));
    await deps.db.touchAdminSession(session.id, toIso(now), expiresAt);
    return { session: { ...session, lastSeenAt: toIso(now), expiresAt }, user };
  }
  return { session, user };
}

/** Bound to the session id, so it changes with every sign-in and needs no storage. */
export function csrfTokenFor(deps: Deps, sessionId: string): string {
  return hashSecret(deps, "csrf", sessionId);
}

export function csrfMatches(deps: Deps, sessionId: string, provided: string | undefined): boolean {
  return secretsMatch(provided, csrfTokenFor(deps, sessionId));
}

export async function logout(deps: Deps, active: ActiveSession): Promise<void> {
  const now = toIso(deps.clock.now());
  await deps.db.revokeAdminSession(active.session.id, active.user.id, now);
  await deps.db.writeAudit({
    userId: active.user.id,
    action: "admin_logout",
    entity: "admin_session",
    entityId: active.session.id,
    metadata: {},
    createdAt: now,
  });
}
