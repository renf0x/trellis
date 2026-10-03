// Test-case workbench: drafts with statuses; a draft goes to Qase only through a confirmed change card.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ExternalLink, MessageSquarePlus, Plus, Save, Send, Trash2, X } from "lucide-react";
import type { ModuleUiProps } from "@trellis/core";
import { ChangeCard, sendToChat, type Proposal } from "@trellis/ui";

const base = "/api/m/workbench";
/** Another module puts a draft id here before navigating, so the workbench opens it. */
const OPEN_KEY = "trellis.workbench.open";

type Status = "todo" | "in_progress" | "clarify" | "done" | "sent";
interface Step { action: string; expected: string }
interface Item {
  id: string; kind: "new" | "edit"; caseId?: string; title: string; suite: string; preconditions: string; steps: Step[];
  status: Status; note?: string; source?: { requirementId?: string; docId?: string; docTitle?: string; text?: string };
  createdId?: string; url?: string; createdAt: string; updatedAt: string;
}
type Draft = Pick<Item, "title" | "suite" | "preconditions" | "steps" | "note">;

const STATUSES: { id: Status; label: string; tone: string }[] = [
  { id: "todo", label: "К работе", tone: "text-dim" },
  { id: "in_progress", label: "В работе", tone: "text-accent" },
  { id: "clarify", label: "Нужно уточнение", tone: "text-warn" },
  { id: "done", label: "Готово", tone: "text-ok" },
  { id: "sent", label: "Отправлено", tone: "text-faint" },
];
const statusOf = (s: Status) => STATUSES.find((x) => x.id === s)!;
const control = "rounded-lg border border-line bg-raised px-3 text-sm outline-none focus:border-accent";
const draftOf = (i: Item): Draft => ({ title: i.title, suite: i.suite, preconditions: i.preconditions, steps: i.steps, note: i.note ?? "" });
const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

function caseText(i: Item, d: Draft) {
  const steps = d.steps.map((s, k) => `${k + 1}. ${s.action}\n   Ожидается: ${s.expected || "—"}`);
  return [
    `Черновик тест-кейса из рабочего места (черновик ${i.id}${i.caseId ? `, кейс ${i.caseId}` : ", новый кейс"})`,
    `Название: ${d.title || "—"}`,
    `Сьют: ${d.suite || "корень проекта"}`,
    i.source?.text ? `Требование${i.source.docTitle ? ` из «${i.source.docTitle}»` : ""}: ${i.source.text}` : "",
    d.preconditions ? `Предусловия: ${d.preconditions}` : "",
    steps.length ? `Шаги:\n${steps.join("\n")}` : "Шагов пока нет.",
    d.note ? `Комментарий тестировщика: ${d.note}` : "",
  ].filter(Boolean).join("\n");
}

export default function Workbench({ api }: ModuleUiProps) {
  const [items, setItems] = useState<Item[]>([]);
  const [counts, setCounts] = useState<Record<Status, number>>({ todo: 0, in_progress: 0, clarify: 0, done: 0, sent: 0 });
  const [filter, setFilter] = useState<Status | "">("");
  const [selected, setSelected] = useState<string | null>(null);
  const [suites, setSuites] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const r = await api.get<{ items: Item[]; counts: Record<Status, number> }>(`${base}/items`);
      setItems(r.items);
      setCounts(r.counts);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api]);

  useEffect(() => {
    void reload();
    api.get<{ suites: string[] }>(`${base}/suites`).then((r) => setSuites(r.suites), () => {});
    try {
      const id = localStorage.getItem(OPEN_KEY);
      if (id) (localStorage.removeItem(OPEN_KEY), setSelected(id));
    } catch {
      /* storage blocked */
    }
  }, [api, reload]);

  async function create() {
    try {
      const it = await api.post<Item>(`${base}/items`, { kind: "new", title: "Новый кейс" });
      await reload();
      setSelected(it.id);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const shown = filter ? items.filter((i) => i.status === filter) : items;
  const current = items.find((i) => i.id === selected) ?? null;
  return (
    <div className="flex h-full min-h-0 gap-4 p-4">
      <aside className="flex w-80 shrink-0 flex-col rounded-xl border border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line p-3">
          <h1 className="flex-1 text-base font-semibold">Рабочее место</h1>
          <button onClick={() => void create()} className="flex h-8 items-center gap-1 rounded-lg bg-accent px-2.5 text-sm"><Plus size={14} /> Новый кейс</button>
        </div>
        <div className="flex flex-wrap gap-1 border-b border-line p-2 text-xs">
          <Chip on={!filter} onClick={() => setFilter("")}>Все {items.length}</Chip>
          {STATUSES.map((s) => (
            <Chip key={s.id} on={filter === s.id} onClick={() => setFilter(s.id)}>{s.label} {counts[s.id]}</Chip>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!shown.length && (
            <p className="p-4 text-sm text-faint">
              {items.length ? "В этом статусе черновиков нет." : "Черновиков пока нет. Нажмите «Новый кейс», «В работу» у непокрытого требования в «Сравнении» или у кейса в «Тест-кейсах»."}
            </p>
          )}
          {shown.map((i) => (
            <button key={i.id} onClick={() => setSelected(i.id)}
              className={`block w-full border-b border-line px-3 py-2.5 text-left last:border-0 ${i.id === selected ? "bg-accent-soft" : "hover:bg-raised"}`}>
              <div className="flex items-center gap-2 text-xs">
                <span className={statusOf(i.status).tone}>{statusOf(i.status).label}</span>
                <span className="text-faint">{i.kind === "new" ? "новый" : `правка ${i.caseId?.split(":")[1] ?? ""}`}</span>
              </div>
              <div className="mt-0.5 truncate text-sm">{i.title || "Без названия"}</div>
              {i.suite && <div className="truncate text-xs text-faint">{i.suite}</div>}
            </button>
          ))}
        </div>
      </aside>
      <section className="min-h-0 min-w-0 flex-1 overflow-auto rounded-xl border border-line bg-panel p-5">
        {error && <p className="mb-3 text-sm text-bad">{error} <button onClick={() => setError(null)} className="text-faint"><X size={12} /></button></p>}
        {current ? (
          <Editor key={current.id} api={api} item={current} suites={suites} onChanged={reload} onDeleted={() => (setSelected(null), void reload())} />
        ) : (
          <div className="text-sm text-dim">
            <p>Выберите черновик слева или создайте новый.</p>
            <p className="mt-2 text-faint">
              Черновик живёт здесь, пока вы его не отправите. Отправка показывает, что будет записано в Qase, и пишет только после подтверждения.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={`rounded-md px-2 py-1 ${on ? "bg-accent-soft text-ink" : "text-dim hover:text-ink"}`}>{children}</button>
  );
}

function Editor({ api, item, suites, onChanged, onDeleted }: {
  api: ModuleUiProps["api"]; item: Item; suites: string[]; onChanged(): Promise<void>; onDeleted(): void;
}) {
  const [d, setD] = useState<Draft>(() => draftOf(item));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState<string | null>(null);
  const saved = useMemo(() => draftOf(item), [item]);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => card.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }), [sending]);
  const dirty = !same(d, saved);

  const act = async (f: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await f();
      await onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await api.post(`${base}/items/${item.id}/delete`);
      onDeleted();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = () => act(() => api.post(`${base}/items/${item.id}`, d));
  const setStatus = (status: Status) => act(() => api.post(`${base}/items/${item.id}`, { status }));
  const step = (k: number, patch: Partial<Step>) => setD({ ...d, steps: d.steps.map((s, i) => (i === k ? { ...s, ...patch } : s)) });
  const move = (k: number, by: number) => {
    const steps = [...d.steps];
    [steps[k], steps[k + by]] = [steps[k + by], steps[k]];
    setD({ ...d, steps });
  };

  /** The change request the connector understands: a new case in the project, or an edit of the case. */
  async function prepare() {
    setError(null);
    const common = {
      target: "case", title: d.title.trim(), preconditions: d.preconditions,
      steps: d.steps.filter((s) => s.action.trim() || s.expected.trim()),
      reason: d.note?.trim() || (item.kind === "new" ? "Новый кейс из рабочего места" : "Правка кейса из рабочего места"),
    };
    if (!common.title) return setError("Нужно название кейса");
    if (item.kind === "edit") return setSending(JSON.stringify({ ...common, id: item.caseId }));
    if (!common.steps.length) return setError("У нового кейса нужен хотя бы один шаг");
    try {
      const s = await api.get<{ project: string }>("/api/m/connector-qase/settings");
      if (!s.project) return setError("Не задан проект Qase: укажите его в настройках коннектора Qase");
      setSending(JSON.stringify({ ...common, create: true, id: `qase:${s.project}`, container: d.suite.trim() }));
    } catch {
      setError("Коннектор Qase выключен: включите его в настройках");
    }
  }

  const applied = (p: Proposal) =>
    void act(() => api.post(`${base}/items/${item.id}`, { status: "sent", proposalId: p.pid, url: p.url, ...(p.createdId ? { createdId: p.createdId } : {}) }));

  const system = item.caseId?.split(":")[0] ?? "qase";
  const sysName = ({ qase: "Qase", jira: "Jira", confluence: "Confluence" } as Record<string, string>)[system] ?? system;
  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center gap-2 text-xs text-faint">
        <span>{item.kind === "new" ? "Новый кейс" : `Правка кейса ${item.caseId?.split(":")[1] ?? ""}`}</span>
        <span>· {item.id}</span>
        {item.url && <a href={item.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent">открыть в {sysName} <ExternalLink size={11} /></a>}
        <select value={item.status} disabled={busy} onChange={(e) => void setStatus(e.target.value as Status)}
          className={`ml-auto h-8 ${control} text-xs ${statusOf(item.status).tone}`}>
          {STATUSES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
        </select>
      </div>

      {item.source?.text && (
        <div className="mt-3 rounded-lg border border-line bg-raised p-3 text-sm">
          <div className="text-xs text-faint">Требование{item.source.docTitle ? ` · ${item.source.docTitle}` : ""}</div>
          <div className="mt-1">{item.source.text}</div>
        </div>
      )}

      <label className="mt-4 block text-xs text-faint">Название</label>
      <input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} className={`mt-1 h-9 w-full ${control}`} />

      <label className="mt-3 block text-xs text-faint">Сьют {item.kind === "edit" && "(для правки не меняется)"}</label>
      <input value={d.suite} onChange={(e) => setD({ ...d, suite: e.target.value })} list="wb-suites" disabled={item.kind === "edit"}
        placeholder="Auth / Вход — пусто значит корень проекта" className={`mt-1 h-9 w-full ${control} disabled:opacity-60`} />
      <datalist id="wb-suites">{suites.map((s) => <option key={s} value={s} />)}</datalist>

      <label className="mt-3 block text-xs text-faint">Предусловия</label>
      <textarea value={d.preconditions} onChange={(e) => setD({ ...d, preconditions: e.target.value })} rows={2}
        className={`mt-1 w-full resize-y py-2 ${control}`} />

      <div className="mt-4 flex items-center text-xs text-faint">
        <span className="flex-1">Шаги</span>
        <button onClick={() => setD({ ...d, steps: [...d.steps, { action: "", expected: "" }] })} className="inline-flex items-center gap-1 text-accent">
          <Plus size={12} /> Шаг
        </button>
      </div>
      <ol className="mt-1 space-y-2">
        {!d.steps.length && <p className="text-sm text-faint">Шагов нет.</p>}
        {d.steps.map((s, k) => (
          <li key={k} className="flex gap-2 rounded-lg bg-raised p-2">
            <span className="w-5 pt-2 text-right text-xs text-faint">{k + 1}</span>
            <div className="grid min-w-0 flex-1 gap-2 md:grid-cols-2">
              <textarea value={s.action} onChange={(e) => step(k, { action: e.target.value })} rows={2} placeholder="Действие"
                className="w-full resize-y rounded-md border border-line bg-panel p-2 text-sm outline-none focus:border-accent" />
              <textarea value={s.expected} onChange={(e) => step(k, { expected: e.target.value })} rows={2} placeholder="Ожидаемый результат"
                className="w-full resize-y rounded-md border border-line bg-panel p-2 text-sm outline-none focus:border-accent" />
            </div>
            <div className="flex flex-col gap-1 text-faint">
              <button disabled={k === 0} onClick={() => move(k, -1)} title="Выше" className="hover:text-ink disabled:opacity-30"><ArrowUp size={13} /></button>
              <button disabled={k === d.steps.length - 1} onClick={() => move(k, 1)} title="Ниже" className="hover:text-ink disabled:opacity-30"><ArrowDown size={13} /></button>
              <button onClick={() => setD({ ...d, steps: d.steps.filter((_, i) => i !== k) })} title="Удалить шаг" className="hover:text-bad"><Trash2 size={13} /></button>
            </div>
          </li>
        ))}
      </ol>

      <label className="mt-4 block text-xs text-faint">Комментарий (что уточнить, причина правки — уйдёт в описание правки)</label>
      <input value={d.note ?? ""} onChange={(e) => setD({ ...d, note: e.target.value })} className={`mt-1 h-9 w-full ${control}`} />

      {error && <p className="mt-3 text-sm text-bad">{error}</p>}
      <div className="mt-4 flex flex-wrap gap-2">
        <button disabled={busy || !dirty} onClick={() => void save()} className="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm disabled:opacity-40">
          <Save size={14} /> {dirty ? "Сохранить" : "Сохранено"}
        </button>
        <button onClick={() => sendToChat("main", { title: `Черновик: ${d.title || item.id}`, text: caseText(item, d) })}
          title="Обсудить с агентом: дописать шаги, проверить формулировки" className="flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm text-dim hover:text-ink">
          <MessageSquarePlus size={14} /> В чат
        </button>
        <button disabled={busy || dirty} onClick={() => void prepare()} title={dirty ? "Сначала сохраните черновик" : "Покажет, что будет записано; запись только после подтверждения"}
          className="flex h-9 items-center gap-1.5 rounded-lg border border-line px-3 text-sm hover:bg-raised disabled:opacity-40">
          <Send size={14} /> {item.kind === "new" ? "Отправить в Qase" : `Отправить в ${sysName}`}
        </button>
        <button disabled={busy} onClick={() => confirm("Удалить черновик? В Qase ничего не меняется.") && void remove()}
          className="ml-auto flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-dim hover:text-bad disabled:opacity-40">
          <Trash2 size={14} /> Удалить
        </button>
      </div>
      {sending && !dirty && (
        <div ref={card} className="mt-3">
          <ChangeCard raw={sending} origin="workbench" onApplied={applied} />
        </div>
      )}
    </div>
  );
}
