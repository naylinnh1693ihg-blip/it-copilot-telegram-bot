import { useQuery } from "@tanstack/react-query";
import { api, ApiError, setCsrfToken, type SessionResponse } from "./api";

export const SESSION_KEY = ["session"] as const;

export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: async () => {
      const session = await api<SessionResponse>("/auth/session");
      setCsrfToken(session.csrfToken);
      return session;
    },
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
    staleTime: 5 * 60_000,
  });
}
