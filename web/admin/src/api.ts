/** The only way the browser talks to the server. No Supabase client, no keys: same-origin /admin/api with the session cookie. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

let csrfToken = "";

export function setCsrfToken(token: string): void {
  csrfToken = token;
}

export type HttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

export async function api<T>(path: string, init: { method?: HttpMethod; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (csrfToken) headers["X-CSRF-Token"] = csrfToken;
  }
  let response: Response;
  try {
    response = await fetch(`/admin/api${path}`, {
      method,
      headers,
      credentials: "same-origin",
      body: method === "GET" ? undefined : JSON.stringify(init.body ?? {}),
    });
  } catch {
    throw new ApiError(0, "Could not reach the server. Check your connection and try again.");
  }
  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string"
        ? payload.error
        : `Request failed (${response.status}).`;
    throw new ApiError(response.status, message);
  }
  return payload as T;
}

export interface SessionUser {
  displayName: string | null;
  role: "owner" | "admin" | "user";
}

export interface SessionResponse {
  user: SessionUser;
  csrfToken: string;
  expiresAt?: string;
}

export interface ActivityResponse {
  entries: Array<{ action: string; entity: string; createdAt: string }>;
}

export interface OverviewResponse {
  knowledgeCount: number;
  memoryCount: number;
  monthCostUsd: number | null;
  monthCostLabel: string;
}

export interface KnowledgeEntry {
  entryNumber: number;
  title: string;
  content: string;
  category: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export const MEMORY_TYPES = ["preference", "fact", "context", "equipment", "goal"] as const;

export interface AdminMemory {
  memoryNumber: number;
  content: string;
  memoryType: (typeof MEMORY_TYPES)[number];
  pinned: boolean;
  sourceType: string | null;
  confidence: number | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UsageSummary {
  range: "week" | "month";
  from: string;
  until: string;
  totalUsd: number | null;
  byModel: Array<{ model: string; inputTokens: number; outputTokens: number; costUsd: number | null }>;
  events: Array<{ model: string; purpose: string; inputTokens: number; outputTokens: number; estimatedUsd: number; createdAt: string }>;
}
