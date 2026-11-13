import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { api, type UsageSummary } from "../api";

function formatUsd(amount: number | null): string {
  if (amount === null) return "Price unknown";
  const cents = Math.round(amount * 100 + 1e-8);
  if (amount > 0 && cents === 0) return `$${amount.toFixed(4)}`;
  return `$${(cents / 100).toFixed(2)}`;
}

export function Usage() {
  const [range, setRange] = useState<"week" | "month">("month");
  const usage = useQuery({
    queryKey: ["usage", range],
    queryFn: () => api<UsageSummary>(`/usage?range=${range}`),
  });

  const data = usage.data;

  return (
    <section>
      <h1>Usage &amp; billing</h1>
      <div className="toolbar">
        <button type="button" className={`button${range === "week" ? " primary" : ""}`} onClick={() => setRange("week")}>
          This week
        </button>
        <button type="button" className={`button${range === "month" ? " primary" : ""}`} onClick={() => setRange("month")}>
          This month
        </button>
      </div>

      {usage.isPending ? <p className="muted">Loading…</p> : null}
      {usage.error ? <p className="error">{usage.error.message}</p> : null}

      {data ? (
        <>
          <div className="stat-grid">
            <div className="card stat">
              <span className="stat-label">Estimated total</span>
              <span className="stat-value">{formatUsd(data.totalUsd)}</span>
            </div>
            <div className="card stat">
              <span className="stat-label">Period</span>
              <span className="stat-value small">
                {new Date(data.from).toLocaleDateString()} – {new Date(data.until).toLocaleDateString()}
              </span>
            </div>
          </div>

          <h2>By model</h2>
          <div className="card">
            {data.byModel.length === 0 ? <p className="muted">No AI usage in this period.</p> : null}
            {data.byModel.length > 0 ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    <th>Input</th>
                    <th>Output</th>
                    <th>Est. cost</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byModel.map((row) => (
                    <tr key={row.model}>
                      <td>{row.model}</td>
                      <td>{row.inputTokens.toLocaleString()}</td>
                      <td>{row.outputTokens.toLocaleString()}</td>
                      <td>{formatUsd(row.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>

          <h2>Recent calls</h2>
          <div className="card">
            {data.events.length === 0 ? <p className="muted">No events logged.</p> : null}
            {data.events.length > 0 ? (
              <table className="data-table">
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Purpose</th>
                    <th>Model</th>
                    <th>Tokens</th>
                  </tr>
                </thead>
                <tbody>
                  {data.events.map((event, index) => (
                    <tr key={`${event.createdAt}-${index}`}>
                      <td>{new Date(event.createdAt).toLocaleString()}</td>
                      <td>{event.purpose}</td>
                      <td>{event.model}</td>
                      <td>
                        {event.inputTokens} in / {event.outputTokens} out
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
