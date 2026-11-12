import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, setCsrfToken, type SessionResponse } from "../api";
import { SESSION_KEY } from "../session";

/**
 * Read once when this module loads. A useState initializer runs twice in Strict Mode,
 * and clearing the hash on the first pass made the second pass lose the sign-in token.
 */
function readLoginToken(): string {
  if (typeof window === "undefined") return "";
  const match = window.location.hash.match(/^#token=([A-Za-z0-9_-]{20,128})$/);
  if (match) window.history.replaceState(null, "", window.location.pathname + window.location.search);
  return match?.[1] ?? "";
}

const loginToken = readLoginToken();

export function Login() {
  const [token] = useState(loginToken);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const signIn = useMutation({
    mutationFn: () => api<SessionResponse>("/auth/magic", { method: "POST", body: { token } }),
    onSuccess: (session) => {
      setCsrfToken(session.csrfToken);
      queryClient.setQueryData(SESSION_KEY, session);
      navigate("/", { replace: true });
    },
  });

  return (
    <div className="login">
      <div className="card login-card">
        <h1>IT Copilot Admin</h1>
        {token && !signIn.isError ? (
          <>
            <p>Tap the button to finish signing in. The link works once.</p>
            <button type="button" className="button primary" disabled={signIn.isPending} onClick={() => signIn.mutate()}>
              {signIn.isPending ? "Signing in…" : "Sign in"}
            </button>
          </>
        ) : (
          <>
            {signIn.isError ? <p className="error">{signIn.error.message}</p> : null}
            <p>
              Send <code>/admin</code> to your bot in Telegram. It replies with a sign-in link that works once and expires after 10 minutes.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
