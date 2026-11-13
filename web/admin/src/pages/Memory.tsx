import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { api, type AdminMemory, MEMORY_TYPES } from "../api";

export function Memory() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [type, setType] = useState("");
  const [editing, setEditing] = useState<AdminMemory | null>(null);
  const [content, setContent] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [newContent, setNewContent] = useState("");

  const params = new URLSearchParams();
  if (search) params.set("q", search);
  if (type) params.set("type", type);
  params.set("limit", "100");

  const list = useQuery({
    queryKey: ["memories", search, type],
    queryFn: () => api<{ memories: AdminMemory[] }>(`/memories?${params.toString()}`),
  });

  const patch = useMutation({
    mutationFn: (body: { memoryNumber: number; patch: Partial<Pick<AdminMemory, "content" | "pinned" | "memoryType">> }) =>
      api<{ memory: AdminMemory }>(`/memories/${body.memoryNumber}`, { method: "PATCH", body: body.patch }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      setEditing(null);
    },
  });

  const create = useMutation({
    mutationFn: () => api<{ memory: AdminMemory }>("/memories", { method: "POST", body: { content: newContent } }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      setShowCreate(false);
      setNewContent("");
    },
  });

  const remove = useMutation({
    mutationFn: (memoryNumber: number) => api<{ ok: true }>(`/memories/${memoryNumber}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["memories"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      setEditing(null);
    },
  });

  const memories = useMemo(() => list.data?.memories ?? [], [list.data]);

  return (
    <section>
      <h1>Memory</h1>
      <div className="toolbar">
        <input className="field" placeholder="Search" value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(e) => e.key === "Enter" && setSearch(query.trim())} />
        <select className="field" value={type} onChange={(event) => setType(event.target.value)}>
          <option value="">All types</option>
          {MEMORY_TYPES.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <button type="button" className="button" onClick={() => setSearch(query.trim())}>
          Search
        </button>
        <button type="button" className="button primary" onClick={() => setShowCreate(true)}>
          New memory
        </button>
      </div>

      {showCreate ? (
        <div className="card stack">
          <h2>New memory</h2>
          <textarea className="field area" rows={5} value={newContent} onChange={(event) => setNewContent(event.target.value)} />
          {create.isError ? <p className="error">{create.error.message}</p> : null}
          <div className="toolbar">
            <button type="button" className="button primary" disabled={create.isPending || !newContent.trim()} onClick={() => create.mutate()}>
              Save
            </button>
            <button type="button" className="button" onClick={() => { setShowCreate(false); setNewContent(""); }}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {editing ? (
        <div className="card stack">
          <h2>Edit #{editing.memoryNumber}</h2>
          <textarea className="field area" rows={5} value={content} onChange={(event) => setContent(event.target.value)} />
          {patch.isError ? <p className="error">{patch.error.message}</p> : null}
          <div className="toolbar">
            <button
              type="button"
              className="button primary"
              disabled={patch.isPending || !content.trim()}
              onClick={() => patch.mutate({ memoryNumber: editing.memoryNumber, patch: { content } })}
            >
              Save text
            </button>
            <button type="button" className="button" onClick={() => setEditing(null)}>
              Close
            </button>
          </div>
        </div>
      ) : null}

      <div className="card">
        <h2>Saved memories</h2>
        {list.isPending ? <p className="muted">Loading…</p> : null}
        {list.error ? <p className="error">{list.error.message}</p> : null}
        {memories.length === 0 && !list.isPending ? <p className="muted">No memories yet.</p> : null}
        <ul className="list entity-list">
          {memories.map((memory) => (
            <li key={memory.memoryNumber}>
              <div className="row-main">
                <strong>
                  {memory.memoryNumber}. {memory.memoryType}
                  {memory.pinned ? " · pinned" : ""}
                </strong>
                <span className="muted">{memory.sourceType ?? "—"} · {new Date(memory.updatedAt).toLocaleString()}</span>
                <p className="excerpt">{memory.content}</p>
              </div>
              <div className="row-actions">
                <label className="pin-toggle">
                  <input
                    type="checkbox"
                    checked={memory.pinned}
                    onChange={(event) => patch.mutate({ memoryNumber: memory.memoryNumber, patch: { pinned: event.target.checked } })}
                  />
                  Pin
                </label>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    setEditing(memory);
                    setContent(memory.content);
                  }}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => {
                    if (window.confirm(`Delete memory #${memory.memoryNumber}?`)) remove.mutate(memory.memoryNumber);
                  }}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
