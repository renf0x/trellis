// Documentation remarks: kept by the compare module (its quality stage writes them, the tester adds more),
// shown here grouped by status. Without the compare module the section simply doesn't appear.
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, MessageSquarePlus, Plus, Trash2 } from "lucide-react";
import type { ModuleUiProps } from "@trellis/core";
import { sendToChat } from "@trellis/ui";

type Api = ModuleUiProps["api"];
export type RemarkStatus = "new" | "fixed" | "postponed" | "wontfix";
export interface Remark {
  id: string;
  docId: string;
  criterion: string;
  summary: string;
  suggestion?: string;
  note?: string;
  status: RemarkStatus;
  origin: "analysis" | "manual";
  updatedAt: string;
  doc?: { id: string; title: string; path: string; url?: string };
}
type Counts = Record<RemarkStatus, number>;

const base = "/api/m/compare/remarks";
export const STATUSES: { id: RemarkStatus; label: string; tone: string }[] = [
  { id: "new", label: "Новые", tone: "text-warn" },
  { id: "fixed", label: "Исправлено", tone: "text-ok" },
  { id: "postponed", label: "Отложено", tone: "text-dim" },
  { id: "wontfix", label: "Не требует исправления", tone: "text-faint" },
];
const CRITERION: Record<string, string> = {
  consistency: "Непротиворечивость", atomicity: "Атомарность", verifiability: "Проверяемость",
  completeness: "Полнота", unambiguity: "Однозначность", other: "Замечание",
};

/** Remarks of one doc, or of all docs; `available` is false when the compare module is off. */
export function useRemarks(api: Api, docId?: string) {
  const [items, setItems] = useState<Remark[]>([]);
  const [counts, setCounts] = useState<Counts>({ new: 0, fixed: 0, postponed: 0, wontfix: 0 });
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await api.get<{ items: Remark[]; counts: Counts }>(`${base}${docId ? `?docId=${encodeURIComponent(docId)}` : ""}`);
      setItems(r.items);
      setCounts(r.counts);
      setAvailable(true);
    } catch {
      setAvailable(false);
    }
  }, [api, docId]);
  useEffect(() => void reload(), [reload]);
  const act = async (f: () => Promise<unknown>) => {
    setError(null);
    try {
      await f();
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return {
    items, counts, available, error, reload,
    update: (id: string, patch: { status?: RemarkStatus; note?: string }) => act(() => api.post(`${base}/${id}`, patch)),
    add: (summary: string, suggestion?: string) => act(() => api.post(base, { docId, summary, suggestion })),
    remove: (id: string) => act(() => api.post(`${base}/${id}/delete`)),
  };
}

const toChat = (r: Remark) =>
  sendToChat("main", {
    title: `Замечание: ${r.summary.slice(0, 60)}`,
    text: [
      `Замечание к документации${r.doc ? ` «${r.doc.title}» (id: ${r.docId})` : ` (id: ${r.docId})`}`,
      `Критерий: ${CRITERION[r.criterion] ?? r.criterion}. Статус: ${STATUSES.find((s) => s.id === r.status)?.label}.`,
      r.summary,
      r.suggestion ? `Предложение: ${r.suggestion}` : "",
      r.note ? `Комментарий тестировщика: ${r.note}` : "",
    ].filter(Boolean).join("\n"),
  });

/** All remarks, one section per status. */
export function RemarksBoard({ api, onOpenDoc }: { api: Api; onOpenDoc(id: string): void }) {
  const rm = useRemarks(api);
  const [open, setOpen] = useState<Record<RemarkStatus, boolean>>({ new: true, fixed: false, postponed: true, wontfix: false });
  if (!rm.available) return <p className="text-faint">Замечания ведёт модуль «Сравнение»: включите его в настройках.</p>;
  const total = STATUSES.reduce((a, s) => a + rm.counts[s.id], 0);
  return (
    <div>
      <h1 className="text-2xl font-semibold">Замечания к документации</h1>
      <p className="mt-1 text-sm text-dim">
        Замечания пишет анализ качества документации в разделе «Сравнение», можно добавлять и свои на странице документа.
        Статус меняется здесь: замечание переходит в свой раздел.
      </p>
      {rm.error && <p className="mt-2 text-sm text-bad">{rm.error}</p>}
      {!total && <p className="mt-6 text-faint">Замечаний пока нет.</p>}
      {STATUSES.map((s) => {
        const list = rm.items.filter((r) => r.status === s.id);
        return (
          <section key={s.id} className="mt-5">
            <button onClick={() => setOpen({ ...open, [s.id]: !open[s.id] })} className="flex w-full items-center gap-2 border-b border-line pb-1.5 text-left">
              <ChevronRight size={15} className={open[s.id] ? "rotate-90" : ""} />
              <span className={`font-medium ${s.tone}`}>{s.label}</span>
              <span className="text-sm text-faint">{rm.counts[s.id]}</span>
            </button>
            {open[s.id] && (
              <div className="mt-2 space-y-2">
                {!list.length && <p className="pl-6 text-sm text-faint">Пусто.</p>}
                {list.map((r) => <RemarkCard key={r.id} r={r} rm={rm} onOpenDoc={onOpenDoc} />)}
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** Remarks of the open page, with adding a new one. */
export function DocRemarks({ api, docId }: { api: Api; docId: string }) {
  const rm = useRemarks(api, docId);
  const [adding, setAdding] = useState(false);
  const [summary, setSummary] = useState("");
  const [suggestion, setSuggestion] = useState("");
  if (!rm.available) return null;
  const active = rm.counts.new + rm.counts.postponed;
  return (
    <details className="mb-5 rounded-lg border border-line" open={rm.counts.new > 0}>
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 text-sm">
        <span>Замечания к странице</span>
        {STATUSES.map((s) => rm.counts[s.id] > 0 && <span key={s.id} className={`text-xs ${s.tone}`}>{s.label.toLowerCase()}: {rm.counts[s.id]}</span>)}
        {!active && !rm.items.length && <span className="text-xs text-faint">нет</span>}
      </summary>
      <div className="space-y-2 border-t border-line p-3">
        {rm.error && <p className="text-sm text-bad">{rm.error}</p>}
        {rm.items.map((r) => <RemarkCard key={r.id} r={r} rm={rm} />)}
        {adding ? (
          <div className="space-y-2 rounded-lg bg-raised p-3">
            <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} placeholder="Что не так в документации"
              className="w-full resize-y rounded-md border border-line bg-panel p-2 text-sm outline-none focus:border-accent" />
            <input value={suggestion} onChange={(e) => setSuggestion(e.target.value)} placeholder="Как исправить (необязательно)"
              className="h-8 w-full rounded-md border border-line bg-panel px-2 text-sm outline-none focus:border-accent" />
            <div className="flex gap-2">
              <button disabled={!summary.trim()}
                onClick={() => void rm.add(summary.trim(), suggestion.trim() || undefined).then(() => (setSummary(""), setSuggestion(""), setAdding(false)))}
                className="h-8 rounded-lg bg-accent px-3 text-sm disabled:opacity-40">Добавить</button>
              <button onClick={() => setAdding(false)} className="h-8 rounded-lg px-3 text-sm text-dim hover:text-ink">Отмена</button>
            </div>
          </div>
        ) : (
          <button onClick={() => setAdding(true)} className="inline-flex items-center gap-1 text-xs text-accent"><Plus size={13} /> Добавить замечание</button>
        )}
      </div>
    </details>
  );
}

function RemarkCard({ r, rm, onOpenDoc }: { r: Remark; rm: ReturnType<typeof useRemarks>; onOpenDoc?(id: string): void }) {
  const [note, setNote] = useState(r.note ?? "");
  return (
    <div className="rounded-lg border border-line bg-panel p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
        <span>{CRITERION[r.criterion] ?? r.criterion}</span>
        {r.origin === "manual" && <span>· добавлено вручную</span>}
        {onOpenDoc && r.doc && (
          <button onClick={() => onOpenDoc(r.docId)} className="min-w-0 truncate text-accent hover:underline" title={r.doc.path}>{r.doc.title}</button>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          <select value={r.status} onChange={(e) => void rm.update(r.id, { status: e.target.value as RemarkStatus })}
            className="h-7 rounded-md border border-line bg-raised px-1.5 text-xs text-ink outline-none">
            {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.id === "new" ? "Новое" : s.label}</option>)}
          </select>
          <button onClick={() => toChat(r)} title="Обсудить с агентом или попросить правку страницы" className="text-dim hover:text-ink"><MessageSquarePlus size={14} /></button>
          {r.origin === "manual" && <button onClick={() => void rm.remove(r.id)} title="Удалить" className="text-dim hover:text-bad"><Trash2 size={14} /></button>}
        </span>
      </div>
      <div className="mt-1">{r.summary}</div>
      {r.suggestion && <div className="mt-1 text-dim">→ {r.suggestion}</div>}
      <input value={note} onChange={(e) => setNote(e.target.value)} onBlur={() => note !== (r.note ?? "") && void rm.update(r.id, { note })}
        placeholder="Комментарий (почему отложено, где исправлено…)"
        className="mt-2 h-7 w-full rounded-md border border-transparent bg-transparent px-1 text-xs text-dim outline-none hover:border-line focus:border-accent" />
    </div>
  );
}
