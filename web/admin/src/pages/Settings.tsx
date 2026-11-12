import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api, setCsrfToken } from "../api";
import { useSession } from "../session";

export function Settings() {
  const session = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const logout = useMutation({
    mutationFn: () => api<{ ok: true }>("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      setCsrfToken("");
      queryClient.clear();
      navigate("/login", { replace: true });
    },
  });
  const expires = session.data?.expiresAt ? new Date(session.data.expiresAt).toLocaleString() : null;

  return (
    <section>
      <h1>Settings</h1>
      <div className="card">
        <h2>Account</h2>
        <dl className="details">
          <dt>Name</dt>
          <dd>{session.data?.user.displayName ?? "—"}</dd>
          <dt>Role</dt>
          <dd>{session.data?.user.role ?? "—"}</dd>
          {expires ? (
            <>
              <dt>Session ends</dt>
              <dd>{expires} if unused</dd>
            </>
          ) : null}
        </dl>
        {logout.isError ? <p className="error">{logout.error.message}</p> : null}
        <button type="button" className="button" disabled={logout.isPending} onClick={() => logout.mutate()}>
          {logout.isPending ? "Signing out…" : "Sign out"}
        </button>
      </div>
    </section>
  );
}
