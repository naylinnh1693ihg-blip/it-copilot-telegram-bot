import { useQuery } from "@tanstack/react-query";
import { api, type ActivityResponse } from "../api";

const ACTION_LABELS: Record<string, string> = {
  admin_login: "Signed in to the admin app",
  admin_logout: "Signed out of the admin app",
  admin_link_issued: "Sign-in link sent by the bot",
};

function label(action: string): string {
  return ACTION_LABELS[action] ?? action.replace(/_/g, " ");
}

export function Dashboard() {
  const activity = useQuery({ queryKey: ["activity"], queryFn: () => api<ActivityResponse>("/activity") });
  return (
    <section>
      <h1>Home</h1>
      <div className="stat-grid">
        <div className="card stat">
          <span className="stat-label">Cost this month</span>
          <span className="stat-pending">Added in the Usage phase</span>
        </div>
        <div className="card stat">
          <span className="stat-label">Items stored</span>
          <span className="stat-pending">Added in the Knowledge phase</span>
        </div>
        <div className="card stat">
          <span className="stat-label">Memories</span>
          <span className="stat-pending">Added in the Memory phase</span>
        </div>
      </div>

      <h2>Recent activity</h2>
      <div className="card">
        {activity.isPending ? <p className="muted">Loading…</p> : null}
        {activity.error ? <p className="error">{activity.error.message}</p> : null}
        {activity.data && activity.data.entries.length === 0 ? <p className="muted">No activity yet.</p> : null}
        {activity.data && activity.data.entries.length > 0 ? (
          <ul className="list">
            {activity.data.entries.map((entry, index) => (
              <li key={`${entry.createdAt}-${index}`}>
                <span>{label(entry.action)}</span>
                <time className="muted" dateTime={entry.createdAt}>
                  {new Date(entry.createdAt).toLocaleString()}
                </time>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
