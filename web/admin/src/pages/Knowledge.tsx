import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo, useState } from "react";
import { api, type KnowledgeEntry } from "../api";

const emptyForm = { title: "", content: "", category: "", tags: "" };

export function Knowledge() {
  const queryClient = useQueryClient();
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<KnowledgeEntry | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [showCreate, setShowCreate] = useState(false);

  const list = useQuery({
    queryKey: ["knowledge", search],
    queryFn: () => api<{ entries: KnowledgeEntry[] }>(`/knowledge${search ? `?q=${encodeURIComponent(search)}` : ""}`),
  });

  const save = useMutation({
    mutationFn: (body: { mode: "create" | "update"; entryNumber?: number; data: typeof emptyForm }) =>
      body.mode === "create"
        ? api<{ entry: KnowledgeEntry }>("/knowledge", {
            method: "POST",
            body: { title: body.data.title, content: body.data.content, category: body.data.category, tags: body.data.tags },
          })
        : api<{ entry: KnowledgeEntry }>(`/knowledge/${body.entryNumber}`, {
            method: "PATCH",
            body: { title: body.data.title, content: body.data.content, category: body.data.category, tags: body.data.tags },
          }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      setShowCreate(false);
      setEditing(null);
      setForm(emptyForm);
    },
  });

  const remove = useMutation({
    mutationFn: (entryNumber: number) => api<{ ok: true }>(`/knowledge/${entryNumber}`, { method: "DELETE" }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["knowledge"] });
      queryClient.invalidateQueries({ queryKey: ["overview"] });
      setEditing(null);
    },
  });

  const entries = useMemo(() => list.data?.entries ?? [], [list.data]);

  function openCreate() {
    setForm(emptyForm);
    setEditing(null);
    setShowCreate(true);
  }

  function openEdit(entry: KnowledgeEntry) {
    setShowCreate(false);
    setEditing(entry);
    setForm({
      title: entry.title,
      content: entry.content,
      category: entry.category,
      tags: entry.tags.join(", "),
    });
  }

  const formOpen = showCreate || editing;

  return (
    <section>
      <h1>Knowledge</h1>
      <div className="toolbar">
        <input
          className="field"
          placeholder="Search knowledge"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") setSearch(query.trim());
          }}
        />
        <button type="button" className="button" onClick={() => setSearch(query.trim())}>
          Search
        </button>
        <button type="button" className="button primary" onClick={openCreate}>
          New entry
        </button>
      </div>

      {formOpen ? (
        <div className="card stack">
          <h2>{editing ? `Edit #${editing.entryNumber}` : "New entry"}</h2>
          <label className="field-label">
            Title
            <input className="field" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} />
          </label>
          <label className="field-label">
            Category
            <input className="field" value={form.category} onChange={(event) => setForm({ ...form, category: event.target.value })} />
          </label>
          <label className="field-label">
            Tags (comma-separated)
            <input className="field" value={form.tags} onChange={(event) => setForm({ ...form, tags: event.target.value })} />
          </label>
          <label className="field-label">
            Content
            <textarea className="field area" rows={8} value={form.content} onChange={(event) => setForm({ ...form, content: event.target.value })} />
          </label>
          {save.isError ? <p className="error">{save.error.message}</p> : null}
          <div className="toolbar">
            <button
              type="button"
              className="button primary"
              disabled={save.isPending || !form.content.trim()}
              onClick={() =>
                save.mutate({
                  mode: editing ? "update" : "create",
                  entryNumber: editing?.entryNumber,
                  data: form,
                })
              }
            >
              {save.isPending ? "Saving…" : "Save"}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                setShowCreate(false);
                setEditing(null);
                setForm(emptyForm);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      <EntityList title="Entries">
        {list.isPending ? <p className="muted">Loading…</p> : null}
        {list.error ? <p className="error">{list.error.message}</p> : null}
        {entries.length === 0 && !list.isPending ? <p className="muted">No knowledge entries yet.</p> : null}
        {entries.map((entry) => (
          <li key={entry.entryNumber}>
            <div className="row-main">
              <strong>
                {entry.entryNumber}. {entry.title}
              </strong>
              <span className="muted">
                {entry.category} · {new Date(entry.updatedAt).toLocaleString()}
              </span>
              <p className="excerpt">{entry.content.slice(0, 200)}{entry.content.length > 200 ? "…" : ""}</p>
            </div>
            <div className="row-actions">
              <button type="button" className="button" onClick={() => openEdit(entry)}>
                Edit
              </button>
              <button
                type="button"
                className="button"
                disabled={remove.isPending}
                onClick={() => {
                  if (window.confirm(`Delete knowledge #${entry.entryNumber}?`)) remove.mutate(entry.entryNumber);
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </EntityList>
    </section>
  );
}

function EntityList({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="card">
      <h2>{title}</h2>
      <ul className="list entity-list">{children}</ul>
    </div>
  );
}
