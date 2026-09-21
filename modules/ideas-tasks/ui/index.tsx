import { useCallback, useEffect, useState } from "react";
import { Lightbulb, Plus, X } from "lucide-react";
import type { MemoryEntry, ModuleUiProps } from "@trellis/core";

// Labels move to the dictionaries engine in stage 2.
const STATUS: Record<string, { label: string; cls: string }> = {
  idea: { label: "Идея", cls: "bg-accent-soft text-[#7aa2ff]" },
  "in-progress": { label: "В работе", cls: "bg-warn/15 text-warn" },
  done: { label: "Готово", cls: "bg-ok/15 text-ok" },
  rejected: { label: "Отклонено", cls: "bg-raised text-faint" },
};
const BASE = "/api/m/ideas-tasks/ideas";

export default function IdeasTasks({ api, slot }: ModuleUiProps) {
  const [entries, setEntries] = useState<MemoryEntry[] | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const compact = slot !== "center";

  const load = useCallback(() => {
    api.get<{ entries: MemoryEntry[] }>(BASE).then((r) => setEntries(r.entries), (e: Error) => setError(e.message));
  }, [api]);
  useEffect(load, [load]);

  const run = (p: Promise<unknown>) => p.then(() => (setError(null), load()), (e: Error) => setError(e.message));
  const shown = (entries ?? []).filter((e) => filter === "all" || e.status === filter);
  const count = (s: string) => (entries ?? []).filter((e) => s === "all" || e.status === s).length;

  return (
    <section className="rounded-xl border border-line bg-panel p-4">
      <header className="flex items-center gap-2">
        <h2 className={compact ? "text-base font-semibold" : "text-xl font-semibold"}>Идеи и задачи</h2>
        <button
          onClick={() => setAdding((v) => !v)}
          className="ml-auto flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-sm hover:brightness-110"
        >
          {adding ? <X size={15} /> : <Plus size={15} />} {adding ? "Отмена" : "Новая задача"}
        </button>
      </header>

      {adding && <NewIdea onSubmit={(b) => run(api.post(BASE, b)).then(() => setAdding(false))} />}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {["all", ...Object.keys(STATUS)].map((s) => (
          <button
            key={s}
            onClick={() => setFilter(s)}
            className={`rounded-md border px-2.5 py-1 text-xs ${
              filter === s ? "border-accent bg-accent-soft text-ink" : "border-line text-dim hover:text-ink"
            }`}
          >
            {s === "all" ? "Все" : STATUS[s].label} ({count(s)})
          </button>
        ))}
      </div>

      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      {entries === null && !error && <p className="mt-3 text-sm text-dim">Загрузка из Arbor…</p>}
      {entries !== null && shown.length === 0 && (
        <p className="mt-4 text-sm text-faint">Пока пусто. Идеи от людей и агента появятся здесь.</p>
      )}

      <ul className="mt-3 divide-y divide-line">
        {shown.map((e) => (
          <li key={e.id} className="flex items-start gap-3 py-2.5">
            <Lightbulb size={16} className="mt-0.5 shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-sm">{e.title}</div>
              {!compact && e.fields.Summary && <div className="mt-0.5 text-xs text-dim">{e.fields.Summary}</div>}
              <div className="mt-0.5 text-[11px] text-faint">
                {e.id} · {e.fields.Author ?? "—"}
              </div>
            </div>
            <select
              value={e.status}
              onChange={(ev) => run(api.patch(`${BASE}/${e.id}`, { status: ev.target.value }))}
              className={`rounded-md border-0 px-2 py-1 text-xs outline-none ${STATUS[e.status]?.cls ?? "bg-raised"}`}
            >
              {Object.entries(STATUS).map(([k, v]) => (
                <option key={k} value={k} className="bg-panel text-ink">{v.label}</option>
              ))}
              {!STATUS[e.status] && <option value={e.status}>{e.status}</option>}
            </select>
          </li>
        ))}
      </ul>
    </section>
  );
}

function NewIdea({ onSubmit }: { onSubmit: (b: { title: string; summary: string }) => Promise<unknown> }) {
  const [title, setTitle] = useState("");
  const [summary, setSummary] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="mt-3 space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!title.trim()) return;
        setBusy(true);
        onSubmit({ title, summary }).finally(() => setBusy(false));
      }}
    >
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Короткое название"
        className="w-full rounded-lg border border-line bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <textarea
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        placeholder="Что и зачем (необязательно)"
        rows={2}
        className="w-full resize-none rounded-lg border border-line bg-raised px-3 py-2 text-sm outline-none focus:border-accent"
      />
      <button disabled={busy || !title.trim()} className="rounded-lg bg-accent px-3 py-1.5 text-sm disabled:opacity-50">
        {busy ? "Сохраняю…" : "Сохранить в Arbor"}
      </button>
    </form>
  );
}
