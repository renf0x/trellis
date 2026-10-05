// Coverage and quality tabs of the compare module: results of the first two analysis stages.
import { useEffect, useState, type ReactNode } from "react";
import { ClipboardPlus, ExternalLink, MessageSquarePlus } from "lucide-react";
import type { ModuleUiProps } from "@trellis/core";
import { sendToChat } from "@trellis/ui";

const base = "/api/m/compare";
type Api = ModuleUiProps["api"];
interface DocRef { id: string; title: string; path: string; url?: string }
interface CaseRef { id: string; externalId: string; title: string; url?: string }
interface Summary {
  total: number; checked: number; covered: number; partial: number; notCovered: number; unchecked: number; errors: number;
  percent: number | null; partialPercent: number | null;
}
type ReqStatus = "covered" | "partial" | "not_covered" | "unchecked" | "error";
interface Requirement {
  id: string; docId: string; text: string; section?: string; status: ReqStatus; reason?: "no-candidates"; similarity?: number; error?: string;
  verdict?: { confidence: number; comment?: string; engine: string };
  doc?: DocRef; case?: CaseRef;
}
interface CoverageResponse { at: string | null; summary: Summary; docs: (Summary & { doc: DocRef })[]; items: Requirement[] }

const CRITERIA: { id: string; label: string; hint: string }[] = [
  { id: "consistency", label: "Непротиворечивость", hint: "требования не спорят друг с другом" },
  { id: "atomicity", label: "Атомарность", hint: "одно требование — одна проверяемая мысль" },
  { id: "verifiability", label: "Проверяемость", hint: "можно написать тест с явным ожидаемым результатом" },
  { id: "completeness", label: "Полнота", hint: "описаны ошибки, границы и альтернативные сценарии" },
  { id: "unambiguity", label: "Однозначность", hint: "нет «быстро», «удобно», «и т. п.»" },
];
export const criterionLabel = (id: string) => CRITERIA.find((c) => c.id === id)?.label ?? "Прочее";
interface Quality {
  docId: string; doc?: DocRef; error?: string;
  verdict?: { scores: Record<string, number>; overall: number; remarks: { criterion: string; summary: string; suggestion?: string }[]; engine: string; models: string[]; costUsd: number };
}

const REQ: Record<ReqStatus, { label: string; tone: string }> = {
  not_covered: { label: "Не покрыто", tone: "text-bad" },
  partial: { label: "Частично", tone: "text-warn" },
  covered: { label: "Покрыто", tone: "text-ok" },
  unchecked: { label: "Не проверено", tone: "text-faint" },
  error: { label: "Ошибка", tone: "text-bad" },
};
const ENGINE: Record<string, string> = { jev: "Jev", chat: "модель чата", "jev+chat": "Jev + модель чата" };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const tone = (x: number) => (x >= 0.7 ? "bg-ok" : x >= 0.4 ? "bg-warn" : "bg-bad");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "");

export function CoverageTab({ api, past, onError, onToast, navigate }: {
  api: Api; past: string; onError(m: string): void; onToast(m: string): void; navigate: ModuleUiProps["navigate"];
}) {
  const [data, setData] = useState<CoverageResponse | null>(null);
  const [status, setStatus] = useState<ReqStatus | "">("not_covered");
  const [docId, setDocId] = useState("");

  useEffect(() => {
    const q = new URLSearchParams({ status, docId, ...(past ? { run: past } : {}) });
    api.get<CoverageResponse>(`${base}/coverage?${q}`).then(setData, (e: Error) => onError(e.message));
  }, [api, past, status, docId, onError]);

  async function toChat(r: Requirement) {
    try {
      const ctx = await api.get<{ title: string; text: string }>(`${base}/requirements/${r.id}/context${past ? `?run=${past}` : ""}`);
      sendToChat("main", { title: ctx.title, text: ctx.text });
      onToast("Требование добавлено в чат агента");
    } catch (e) {
      onError((e as Error).message);
    }
  }

  /** A draft on the workbench: a new case, or an edit of the case that covers the requirement partly. */
  async function toWork(r: Requirement) {
    const source = { requirementId: r.id, docId: r.docId, docTitle: r.doc?.title, text: r.text };
    const body = r.status === "partial" && r.case
      ? { kind: "edit", caseId: r.case.id, source, note: r.verdict?.comment }
      : { kind: "new", title: r.text.length > 120 ? `${r.text.slice(0, 117)}…` : r.text, source };
    try {
      const it = await api.post<{ id: string }>("/api/m/workbench/items", body);
      try {
        localStorage.setItem("trellis.workbench.open", it.id);
      } catch {
        /* the workbench just opens without a selection */
      }
      navigate("workbench");
    } catch (e) {
      onError(/404|not found/i.test((e as Error).message) ? "Модуль «Рабочее место» выключен: включите его в настройках" : (e as Error).message);
    }
  }

  if (!data) return <p className="p-4 text-sm text-faint">Загрузка…</p>;
  const s = data.summary;
  if (!s.total) return <Empty>Покрытие ещё не считалось: включите этап «Покрытие требований» и запустите анализ.</Empty>;
  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <section className="flex w-[380px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
        <div className="border-b border-line p-4">
          <div className="flex items-baseline gap-2">
            <span className="text-3xl font-semibold">{s.percent ?? "—"}{s.percent !== null && "%"}</span>
            <span className="text-sm text-dim">требований покрыто кейсами</span>
          </div>
          <Bar parts={[[s.covered, "bg-ok"], [s.partial, "bg-warn"], [s.notCovered, "bg-bad"], [s.unchecked + s.errors, "bg-line"]]} />
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-dim">
            <span>Всего: {s.total}</span>
            <span className="text-ok">покрыто {s.covered}</span>
            <span className="text-warn">частично {s.partial}</span>
            <span className="text-bad">не покрыто {s.notCovered}</span>
            {s.unchecked > 0 && <span title="Не уложились в лимит проверок: запустите анализ ещё раз или поднимите «Проверок на этап»">не проверено {s.unchecked}</span>}
            {s.errors > 0 && <span className="text-bad">ошибок {s.errors}</span>}
          </div>
          <p className="mt-2 text-[11px] text-faint">
            Процент — от проверенных требований. Требования выделены из текста автоматически. Модель получает требование
            и до 5 кейсов-кандидатов: похожие по шагам и связанные с этим документом. Если кандидатов нет, требование
            считается непокрытым без проверки моделью. {when(data.at)}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          <DocRow on={!docId} onClick={() => setDocId("")} title="Все документы" percent={s.percent} total={s.total} />
          {data.docs.map((d) => (
            <DocRow key={d.doc.id} on={docId === d.doc.id} onClick={() => setDocId(d.doc.id)} title={d.doc.title} sub={d.doc.path} percent={d.percent} total={d.total} />
          ))}
        </div>
      </section>
      <section className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border border-line bg-panel">
        <div className="flex flex-wrap gap-1.5 border-b border-line p-3">
          {(["not_covered", "partial", "covered", "unchecked", "error", ""] as const).map((k) => (
            <button key={k} onClick={() => setStatus(k)}
              className={`h-8 rounded-lg border px-2.5 text-xs ${status === k ? "border-accent bg-accent-soft" : "border-line text-dim hover:text-ink"}`}>
              {k ? REQ[k].label : "Все"}
            </button>
          ))}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {!data.items.length && <p className="p-4 text-sm text-faint">Таких требований нет.</p>}
          {data.items.map((r) => (
            <div key={r.id} className="border-b border-line px-4 py-3 last:border-0">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <span className={REQ[r.status].tone}>{REQ[r.status].label}</span>
                    {r.verdict && <span className="text-faint">{ENGINE[r.verdict.engine] ?? r.verdict.engine} · {pct(r.verdict.confidence)}</span>}
                    {r.reason === "no-candidates" && <span className="text-faint">похожих кейсов не найдено, модель не проверяла</span>}
                    {!docId && r.doc && <span className="truncate text-faint">{r.doc.title}</span>}
                  </div>
                  {r.section && <div className="mt-1 truncate text-xs text-faint">{r.section}</div>}
                  <div className="mt-1 text-sm">{r.text}</div>
                  {r.case && (
                    <div className="mt-1 text-xs text-dim">
                      {r.status === "not_covered" ? "Ближайший кейс" : "Кейс"}: #{r.case.externalId} {r.case.title}
                      {r.case.url && <a href={r.case.url} target="_blank" rel="noreferrer" className="ml-1 inline-flex text-accent"><ExternalLink size={11} /></a>}
                    </div>
                  )}
                  {r.verdict?.comment && <div className="mt-1 text-xs text-dim">{r.verdict.comment}</div>}
                  {r.error && <div className="mt-1 text-xs text-bad">{r.error}</div>}
                </div>
                <div className="flex shrink-0 flex-col gap-1.5">
                  {(r.status === "not_covered" || r.status === "partial") && (
                    <button onClick={() => void toWork(r)}
                      title={r.status === "partial" && r.case ? "Черновик правки ближайшего кейса на рабочем месте" : "Черновик нового кейса на рабочем месте"}
                      className="flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 text-xs text-dim hover:text-ink">
                      <ClipboardPlus size={13} /> В работу
                    </button>
                  )}
                  <button onClick={() => void toChat(r)} title="Обсудить с агентом: например, попросить черновик тест-кейса"
                    className="flex h-8 items-center gap-1 rounded-lg border border-line px-2.5 text-xs text-dim hover:text-ink">
                    <MessageSquarePlus size={13} /> В чат
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

export function QualityTab({ api, past, onError, navigate }: { api: Api; past: string; onError(m: string): void; navigate: ModuleUiProps["navigate"] }) {
  const [data, setData] = useState<{ at: string | null; items: Quality[] } | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    api.get<{ at: string | null; items: Quality[] }>(`${base}/quality${past ? `?run=${past}` : ""}`).then(setData, (e: Error) => onError(e.message));
  }, [api, past, onError]);

  if (!data) return <p className="p-4 text-sm text-faint">Загрузка…</p>;
  if (!data.items.length) return <Empty>Качество документации ещё не оценивалось: включите этап «Качество документации» и запустите анализ.</Empty>;
  const items = [...data.items].sort((a, b) => (a.verdict?.overall ?? -1) - (b.verdict?.overall ?? -1));
  const current = items.find((q) => q.docId === selected) ?? items[0];
  const avg = (id: string) => {
    const xs = items.flatMap((q) => (q.verdict ? [q.verdict.scores[id] ?? 0] : []));
    return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  };
  return (
    <div className="flex min-h-0 flex-1 gap-4">
      <section className="flex w-[380px] shrink-0 flex-col overflow-hidden rounded-xl border border-line bg-panel">
        <div className="space-y-1.5 border-b border-line p-4 text-xs">
          <div className="mb-1 text-faint">В среднем по {items.length} документам · {when(data.at)}</div>
          {CRITERIA.map((c) => <Score key={c.id} label={c.label} hint={c.hint} value={avg(c.id)} />)}
        </div>
        <div className="min-h-0 flex-1 overflow-auto">
          {items.map((q) => (
            <button key={q.docId} onClick={() => setSelected(q.docId)}
              className={`block w-full border-b border-line px-3 py-2.5 text-left last:border-0 ${current === q ? "bg-accent-soft" : "hover:bg-raised"}`}>
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate text-sm">{q.doc?.title ?? q.docId}</span>
                {q.verdict ? <span className={`rounded px-1.5 text-xs text-white ${tone(q.verdict.overall)}`}>{pct(q.verdict.overall)}</span> : <span className="text-xs text-bad">ошибка</span>}
              </div>
              {!!q.verdict?.remarks.length && <div className="text-xs text-faint">замечаний: {q.verdict.remarks.length}</div>}
            </button>
          ))}
        </div>
      </section>
      <section className="min-w-0 flex-1 overflow-auto rounded-xl border border-line bg-panel p-5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 truncate font-medium">{current.doc?.title ?? current.docId}</span>
          {current.verdict && <span className="text-xs text-faint">{current.verdict.engine === "jev+chat" ? "Jev + модель чата" : current.verdict.engine === "jev" ? "Jev" : "модель чата"} · ${current.verdict.costUsd.toFixed(6)}</span>}
          {current.doc?.url && <a href={current.doc.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex shrink-0 items-center gap-1 text-xs text-accent">Открыть в источнике <ExternalLink size={11} /></a>}
        </div>
        {current.error && <p className="mt-3 text-sm text-bad">{current.error}</p>}
        {current.verdict && (
          <div className="mt-4 space-y-2 text-sm">
            {CRITERIA.map((c) => <Score key={c.id} label={c.label} hint={c.hint} value={current.verdict!.scores[c.id] ?? 0} />)}
          </div>
        )}
        {!!current.verdict?.remarks.length && (
          <ul className="mt-5 space-y-2">
            {current.verdict.remarks.map((r, i) => (
              <li key={i} className="rounded-lg border border-line p-3 text-sm">
                <div className="text-xs text-faint">{criterionLabel(r.criterion)}</div>
                <div>{r.summary}</div>
                {r.suggestion && <div className="mt-1 text-dim">→ {r.suggestion}</div>}
              </li>
            ))}
          </ul>
        )}
        {current.verdict && !current.verdict.remarks.length && current.verdict.overall < 1 && (
          <p className="mt-4 text-xs text-faint">Jev ставит только оценки. Текст замечаний пишет модель чата, если включено «Объяснять моделью чата».</p>
        )}
        <button onClick={() => navigate("docs-view")} className="mt-5 text-xs text-accent hover:underline">
          Замечания и их статусы (исправлено, отложено…) — в разделе «Документация» →
        </button>
      </section>
    </div>
  );
}

function Score({ label, hint, value }: { label: string; hint: string; value: number }) {
  return (
    <div className="flex items-center gap-2" title={hint}>
      <span className="w-40 shrink-0 text-dim">{label}</span>
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><div className={`h-full ${tone(value)}`} style={{ width: pct(value) }} /></div>
      <span className="w-10 text-right text-faint">{pct(value)}</span>
    </div>
  );
}

function DocRow({ on, onClick, title, sub, percent, total }: { on: boolean; onClick(): void; title: string; sub?: string; percent: number | null; total: number }) {
  return (
    <button onClick={onClick} className={`block w-full border-b border-line px-3 py-2 text-left last:border-0 ${on ? "bg-accent-soft" : "hover:bg-raised"}`}>
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm">{title}</span>
        <span className="shrink-0 text-xs text-dim">{percent === null ? "—" : `${percent}%`} из {total}</span>
      </div>
      {sub && <div className="truncate text-xs text-faint">{sub}</div>}
      {percent !== null && <div className="mt-1 h-1 overflow-hidden rounded-full bg-line"><div className={`h-full ${tone(percent / 100)}`} style={{ width: `${percent}%` }} /></div>}
    </button>
  );
}

function Bar({ parts }: { parts: [number, string][] }) {
  const sum = parts.reduce((a, [n]) => a + n, 0) || 1;
  return (
    <div className="mt-2 flex h-2 overflow-hidden rounded-full bg-line">
      {parts.map(([n, c], i) => n > 0 && <div key={i} className={c} style={{ width: `${(n / sum) * 100}%` }} />)}
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="rounded-xl border border-line bg-panel p-6 text-sm text-faint">{children}</p>;
}
