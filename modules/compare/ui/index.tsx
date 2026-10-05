import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Bot, Check, ExternalLink, MessageSquarePlus, Play, Settings, Sparkles, Square, Undo2, X } from "lucide-react";
import type { ModuleUiProps } from "@trellis/core";
import { Block, openInWorkChat } from "@trellis/ui";
import { CoverageTab, QualityTab } from "./stages.tsx";

type Engine = "chat" | "jev";
type Kind = "contradicts" | "partial" | "outdated" | "uncertain" | "no-doc" | "no-case" | "error";
type Status = "new" | "accepted" | "rejected";
type Stage = "quality" | "coverage" | "casedocs" | "pairs";
type Tab = "findings" | "coverage" | "quality";
const STAGES: { id: Stage; label: string; hint: string }[] = [
  { id: "quality", label: "Качество документации", hint: "Jev оценивает каждый документ: непротиворечивость, атомарность, проверяемость, полнота, однозначность" },
  { id: "coverage", label: "Покрытие требований", hint: "Требования выделяются из текста, Jev решает, каким кейсом каждое покрыто" },
  { id: "casedocs", label: "Кейсы без документации", hint: "Для каждого кейса ищутся похожие фрагменты документации, Jev решает, описано ли то, что кейс проверяет. Результат — в «Тест-кейсы → Тесты без документации»" },
  { id: "pairs", label: "Сравнение пар", hint: "Кейс сверяется с похожим документом: противоречия и устаревшие шаги" },
];
/** testcases-view opens on the view saved here. */
const rememberView = (v: string) => {
  try {
    localStorage.setItem("trellis.testcases.view", v);
  } catch { /* it just opens on the list */ }
};
const stageLabel = (s?: Stage) => STAGES.find((x) => x.id === s)?.label;

interface Verdict {
  relation: string;
  actuality: string | null;
  confidence: number;
  engine: "chat" | "jev" | "jev+chat";
  explanation?: string;
  issues: { summary: string; suggestion?: string }[];
  jev?: { relation: Record<string, number>; actuality: Record<string, number>; model: string };
  models: string[];
  costUsd: number;
}
interface Finding {
  id: string;
  kind: Kind;
  status: Status;
  similarity?: number;
  verdict?: Verdict;
  error?: string;
  case?: { id: string; externalId: string; title: string; url?: string };
  doc?: { id: string; title: string; path: string; url?: string };
}
interface Run { engine: Engine; running: boolean; total: number; done: number; costUsd: number; message: string; finishedAt?: string; stages?: Stage[]; stage?: Stage }
interface StatusResponse {
  run: Run | null;
  engines: { chat: string | null; jev: { enabled: boolean; model: string; threshold: number; proxy?: { enabled: boolean; hint: string | null } } };
  data: { docs: number; cases: number; pairs: number; orphanCases: number; uncoveredDocs: number };
  counts: Partial<Record<Kind, number>>;
  links: number;
  quality: number;
  coverage: { total: number; percent: number | null } | null;
  caseDocs?: { undocumented: number; partial: number } | null;
}
interface Context { title: string; text: string }
interface ArchiveItem { slot: string; seq: number; run: Run & { startedAt: string }; findings: number; coverage?: number | null }

const base = "/api/m/compare";
const KINDS: { id: Kind; label: string; tone: string }[] = [
  { id: "contradicts", label: "Противоречие", tone: "text-bad" },
  { id: "outdated", label: "Устарел", tone: "text-bad" },
  { id: "partial", label: "Частично", tone: "text-warn" },
  { id: "uncertain", label: "Неуверенно", tone: "text-warn" },
  { id: "error", label: "Ошибка", tone: "text-bad" },
  { id: "no-doc", label: "Кейс без документации", tone: "text-dim" },
  { id: "no-case", label: "Документ без кейсов", tone: "text-dim" },
];
const kindOf = (k: Kind) => KINDS.find((x) => x.id === k)!;
const RELATION: Record<string, string> = { consistent: "совпадает", partial: "частично", contradicts: "противоречит", unrelated: "не связаны" };
const ACTUALITY: Record<string, string> = { up_to_date: "актуален", partial: "частично устарел", outdated: "устарел", 0: "устарел", 1: "частично", 2: "актуален" };
const ENGINE: Record<Verdict["engine"], string> = { chat: "модель чата", jev: "Jev", "jev+chat": "Jev не уверен → модель чата" };
const pct = (x: number) => `${Math.round(x * 100)}%`;
const when = (iso?: string) => (iso ? new Date(iso).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—");
const btn = "flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm disabled:opacity-40";

export default function Compare({ api, navigate }: ModuleUiProps) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [engine, setEngine] = useState<Engine>("chat");
  const [limit, setLimit] = useState(50);
  const [explain, setExplain] = useState(true);
  const [kind, setKind] = useState<Kind | "">("");
  const [view, setView] = useState<Status | "">("");
  const [items, setItems] = useState<Finding[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // "" is the latest run; otherwise an archived one, shown read only.
  const [past, setPast] = useState("");
  const [runs, setRuns] = useState<ArchiveItem[]>([]);
  const [tab, setTab] = useState<Tab>("findings");
  const [stages, setStages] = useState<Record<Stage, boolean>>(() => {
    try {
      return { quality: true, coverage: true, casedocs: true, pairs: true, ...JSON.parse(localStorage.getItem("trellis.compare.stages") ?? "{}") };
    } catch {
      return { quality: true, coverage: true, casedocs: true, pairs: true };
    }
  });
  const toggleStage = (id: Stage, on: boolean) => {
    const next = { ...stages, [id]: on };
    setStages(next);
    try {
      localStorage.setItem("trellis.compare.stages", JSON.stringify(next));
    } catch { /* private mode: the choice just isn't remembered */ }
  };
  const onError = useCallback((m: string) => setError(m), []);

  const refresh = useCallback(async () => {
    const s = await api.get<StatusResponse>(`${base}/status`);
    setStatus(s);
    const p = new URLSearchParams({ kind, status: view });
    const [found, archive] = await Promise.all([
      api.get<{ items: Finding[] }>(past ? `${base}/runs/${past}?${p}` : `${base}/findings?${p}`),
      api.get<{ items: ArchiveItem[] }>(`${base}/runs`),
    ]);
    setItems(found.items);
    setRuns(archive.items);
    return s;
  }, [api, kind, view, past]);

  useEffect(() => void refresh().catch((e: Error) => setError(e.message)), [refresh]);
  useEffect(() => {
    if (status?.engines.jev.enabled === false && engine === "jev") setEngine("chat");
  }, [status, engine]);
  // Poll while a run is going.
  useEffect(() => {
    if (!status?.run?.running) return;
    const t = setInterval(() => void refresh().catch(() => {}), 1500);
    return () => clearInterval(t);
  }, [status?.run?.running, refresh]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(t);
  }, [toast]);

  const post = <T,>(path: string, body: unknown) => api.post<T>(`${base}${path}`, body);
  async function run() {
    setError(null);
    try {
      setPast("");
      await post("/run", { engine, limit, explain, stages });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function setFindingStatus(id: string, s: Status) {
    try {
      await post(`/findings/${id}`, { status: s });
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    }
  }
  async function toChat(f: Finding, quote?: string) {
    try {
      const ctx = await api.get<Context>(`${base}/findings/${f.id}/context${past ? `?run=${past}` : ""}`);
      // Its own tab in the workbench chat; the app switches there.
      openInWorkChat({ kind: "finding", key: `finding:${f.id}`, title: ctx.title },
        { title: `${kindOf(f.kind).label}: ${ctx.title}`, text: ctx.text, quote });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!status) return <p className="text-dim">{error ?? "Загрузка…"}</p>;
  const { run: r, engines, data } = status;
  const current = items.find((f) => f.id === selected) ?? null;
  const noDocs = !data.docs;
  const needCases = (stages.coverage || stages.casedocs || stages.pairs) && !data.cases;
  const noStage = !STAGES.some((s) => stages[s.id]);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <section className="rounded-xl border border-line bg-panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex rounded-lg border border-line p-0.5">
            <EngineButton on={engine === "chat"} onClick={() => setEngine("chat")} icon={<Bot size={15} />}
              label="Модель чата" hint={engines.chat ?? "не выбрана"} />
            <EngineButton on={engine === "jev"} disabled={!engines.jev.enabled} onClick={() => setEngine("jev")}
              icon={<Sparkles size={15} />} label="Jev" hint={engines.jev.enabled
                ? `порог ${pct(engines.jev.threshold)}${engines.jev.proxy?.enabled && engines.jev.proxy.hint ? " · через прокси" : ""}`
                : "выключен"} />
          </div>
          <label className="flex items-center gap-2 text-sm text-dim" title="Сколько документов, требований и пар проверить моделью на каждом этапе за один запуск">
            Проверок на этап
            <input type="number" min={1} max={2000} value={limit} onChange={(e) => setLimit(Number(e.target.value))}
              className="h-9 w-20 rounded-lg border border-line bg-raised px-2 text-ink outline-none focus:border-accent" />
          </label>
          {engine === "jev" && (
            <label className="flex items-center gap-2 text-sm text-dim" title="Модель чата пишет объяснения к находкам и решает пары, где Jev не уверен">
              <input type="checkbox" checked={explain} onChange={(e) => setExplain(e.target.checked)} disabled={!engines.chat} />
              Объяснять моделью чата
            </label>
          )}
          <div className="ml-auto flex gap-2">
            {!engines.jev.enabled && (
              <button onClick={() => navigate("settings")} className={`${btn} border border-line text-dim hover:text-ink`}>
                <Settings size={15} /> Включить Jev
              </button>
            )}
            {r?.running ? (
              <button onClick={() => void post("/stop", {})} className={`${btn} bg-bad/80`}><Square size={14} /> Остановить</button>
            ) : (
              <button onClick={() => void run()} disabled={noDocs || needCases || noStage || (engine === "chat" && !engines.chat)} className={`${btn} bg-accent`}>
                <Play size={15} /> Запустить анализ
              </button>
            )}
          </div>
        </div>
        <Block id="compare/stages" title="Сравнение · Этапы анализа">
        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
          <span className="text-xs text-faint">Этапы:</span>
          {STAGES.map((st, i) => (
            <label key={st.id} title={st.hint} className="flex items-center gap-1.5 text-dim">
              <input type="checkbox" checked={stages[st.id]} onChange={(e) => toggleStage(st.id, e.target.checked)} disabled={r?.running} />
              <span className="text-faint">{i + 1}.</span> {st.label}
            </label>
          ))}
          {noStage && <span className="text-xs text-warn">Включите хотя бы один этап</span>}
        </div>
        </Block>
        <Block id="compare/stats" title="Сравнение · Сводка по данным">
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-faint">
          <span>Документов: {data.docs}</span>
          <span>Кейсов: {data.cases}</span>
          <span title="Пары подобраны по совпадению слов, без модели">Кандидатов в пары: {data.pairs}</span>
          <span title="Кейсы, у которых нет похожего документа по совпадению слов, без модели">Кейсов без похожего документа: {data.orphanCases}</span>
          <span>Документов без кейсов: {data.uncoveredDocs}</span>
          <span>Подтверждённых связей: {status.links}</span>
          {status.caseDocs && (
            <button onClick={() => (rememberView("nodocs"), navigate("testcases-view"))} className="text-accent" title="Открыть «Тест-кейсы → Тесты без документации»">
              Тестов без документации: {status.caseDocs.undocumented}{status.caseDocs.partial ? `, частично: ${status.caseDocs.partial}` : ""}
            </button>
          )}
          {status.coverage && <span>Покрытие требований: {status.coverage.percent ?? "—"}{status.coverage.percent !== null && "%"} из {status.coverage.total}</span>}
        </div>
        </Block>
        {noDocs && <p className="mt-2 text-sm text-warn">Нет документации: загрузите её из Confluence или Jira.</p>}
        {!noDocs && needCases && <p className="mt-2 text-sm text-warn">Для покрытия и сравнения нужны тест-кейсы: загрузите их из Qase или оставьте только этап «Качество документации».</p>}
        {r && (
          <div className="mt-3">
            {r.running && (
              <div className="mb-1 h-1.5 overflow-hidden rounded-full bg-raised">
                <div className="h-full bg-accent transition-all" style={{ width: `${r.total ? (r.done / r.total) * 100 : 0}%` }} />
              </div>
            )}
            <div className="text-xs text-dim">
              {r.running ? `${stageLabel(r.stage) ?? "Подготовка"} · проверено ${r.done} из ${r.total}` : r.message} · {r.engine === "jev" ? "Jev" : "модель чата"} · ${r.costUsd.toFixed(5)}
            </div>
          </div>
        )}
        {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      </section>

      <div className="flex flex-wrap items-center gap-1.5">
        <div className="flex rounded-lg border border-line p-0.5">
          {([["findings", "Находки"], ["coverage", "Покрытие"], ["quality", "Качество документации"]] as const).map(([id, label]) => (
            <button key={id} onClick={() => setTab(id)}
              className={`rounded-md px-3 py-1 text-sm ${tab === id ? "bg-accent-soft text-ink" : "text-dim hover:text-ink"}`}>{label}</button>
          ))}
        </div>
        {runs.length > 0 && (
          <select value={past} onChange={(e) => (setPast(e.target.value), setSelected(null))} title="Прошлые запуски хранятся в архиве (последние 20)"
            className="ml-auto h-8 max-w-[320px] rounded-lg border border-line bg-raised px-2 text-xs outline-none">
            <option value="">Последний запуск</option>
            {runs.slice(1).map((x) => (
              <option key={x.slot} value={x.slot}>
                {when(x.run.finishedAt ?? x.run.startedAt)} · {x.run.engine === "jev" ? "Jev" : "модель чата"} · находок {x.findings}
                {x.coverage != null ? ` · покрытие ${x.coverage}%` : ""}
              </option>
            ))}
          </select>
        )}
      </div>

      {tab === "coverage" && <CoverageTab key={`${past}/${r?.finishedAt}`} api={api} past={past} onError={onError} onToast={setToast} navigate={navigate} />}
      {tab === "quality" && <QualityTab key={`${past}/${r?.finishedAt}`} api={api} past={past} onError={onError} navigate={navigate} />}
      {tab === "findings" && (<>
      <Block id="compare/filters" title="Сравнение · Фильтры находок">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip on={!kind} onClick={() => setKind("")}>Все</Chip>
        {KINDS.map((k) => (
          <Chip key={k.id} on={kind === k.id} onClick={() => setKind(k.id)}>
            {k.label} <span className="text-faint">{status.counts[k.id] ?? 0}</span>
          </Chip>
        ))}
        <select value={view} onChange={(e) => setView(e.target.value as Status | "")}
          className="ml-auto h-8 rounded-lg border border-line bg-raised px-2 text-xs outline-none">
          <option value="">Активные</option>
          <option value="accepted">Принятые</option>
          <option value="rejected">Отклонённые</option>
        </select>
      </div>
      </Block>

      <div className="flex min-h-0 flex-1 gap-4">
        <section className="w-[380px] shrink-0 overflow-auto rounded-xl border border-line bg-panel">
          {!items.length && <p className="p-4 text-sm text-faint">{r ? "Находок нет." : "Анализ ещё не запускался."}</p>}
          {items.map((f) => (
            <button key={f.id} onClick={() => setSelected(f.id)}
              className={`block w-full border-b border-line px-3 py-2.5 text-left last:border-0 ${selected === f.id ? "bg-accent-soft" : "hover:bg-raised"}`}>
              <div className="flex items-center gap-2 text-xs">
                <span className={kindOf(f.kind).tone}>{kindOf(f.kind).label}</span>
                {f.verdict && <span className="text-faint">{ENGINE[f.verdict.engine]} · {pct(f.verdict.confidence)}</span>}
                {f.status === "accepted" && <Check size={13} className="ml-auto text-ok" />}
              </div>
              <div className="mt-0.5 truncate text-sm">{f.case ? `#${f.case.externalId} ${f.case.title}` : f.doc?.title}</div>
              {f.case && f.doc && <div className="truncate text-xs text-faint">↔ {f.doc.title}</div>}
            </button>
          ))}
        </section>
        <section className="min-w-0 flex-1 overflow-auto rounded-xl border border-line bg-panel">
          {current ? (
            <Report key={`${past}/${current.id}`} f={current} api={api} past={past} onChat={toChat} onStatus={past ? undefined : setFindingStatus} />
          ) : (
            <p className="p-6 text-sm text-faint">
              Выберите находку слева. Кнопка «В чат» откроет отчёт (или выделенный в нём фрагмент) отдельной вкладкой в чате «Рабочего места»: там можно задать уточняющие вопросы.
            </p>
          )}
        </section>
      </div>
      </>)}
      {toast && <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-lg bg-raised px-4 py-2 text-sm shadow-lg">{toast}</div>}
    </div>
  );
}

function Report({ f, api, past, onChat, onStatus }: {
  f: Finding;
  api: ModuleUiProps["api"];
  past: string;
  onChat(f: Finding, quote?: string): Promise<void>;
  /** Missing for an archived run: its statuses are a snapshot. */
  onStatus?(id: string, s: Status): Promise<void>;
}) {
  const [ctx, setCtx] = useState<Context | null>(null);
  const [sel, setSel] = useState<{ text: string; x: number; y: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const v = f.verdict;

  useEffect(() => {
    api.get<Context>(`${base}/findings/${f.id}/context${past ? `?run=${past}` : ""}`).then(setCtx, () => setCtx(null));
  }, [api, f.id, past]);

  // Selecting text inside the report offers "В чат" next to the selection.
  function onMouseUp() {
    const s = window.getSelection();
    const text = s?.toString().trim() ?? "";
    if (!s || !text || !box.current?.contains(s.anchorNode)) return setSel(null);
    const rect = s.getRangeAt(0).getBoundingClientRect();
    const host = box.current.getBoundingClientRect();
    setSel({ text: text.slice(0, 2000), x: rect.left - host.left + rect.width / 2, y: rect.top - host.top + box.current.scrollTop - 38 });
  }

  return (
    <div ref={box} onMouseUp={onMouseUp} className="relative p-5">
      {sel && (
        <button
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => void onChat(f, sel.text).then(() => (setSel(null), window.getSelection()?.removeAllRanges()))}
          style={{ left: sel.x, top: sel.y }}
          className="absolute z-10 flex -translate-x-1/2 items-center gap-1 rounded-md bg-accent px-2 py-1 text-xs shadow-lg"
        >
          <MessageSquarePlus size={13} /> В чат
        </button>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className={`text-sm font-medium ${kindOf(f.kind).tone}`}>{kindOf(f.kind).label}</span>
        {v && <span className="text-xs text-faint">{ENGINE[v.engine]} · {v.models.join(", ")} · ${v.costUsd.toFixed(6)}</span>}
        <div className="ml-auto flex gap-2">
          <button onClick={() => void onChat(f)} className={`${btn} h-8 bg-accent`}><MessageSquarePlus size={14} /> В чат</button>
          {!onStatus ? (
            <span className="self-center text-xs text-faint">Архивный запуск: только просмотр</span>
          ) : f.status === "new" ? (
            <>
              <button onClick={() => void onStatus(f.id, "accepted")} className={`${btn} h-8 border border-line text-ok`}><Check size={14} /> Принять</button>
              <button onClick={() => void onStatus(f.id, "rejected")} className={`${btn} h-8 border border-line text-dim`}><X size={14} /> Отклонить</button>
            </>
          ) : (
            <button onClick={() => void onStatus(f.id, "new")} className={`${btn} h-8 border border-line text-dim`}>
              <Undo2 size={14} /> {f.status === "accepted" ? "Принято" : "Отклонено"}: вернуть
            </button>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-2 text-sm md:grid-cols-2">
        {f.case && <Source label="Тест-кейс" title={`#${f.case.externalId} ${f.case.title}`} url={f.case.url} />}
        {f.doc && <Source label="Документация" title={f.doc.title} sub={f.doc.path} url={f.doc.url} />}
      </div>

      {v && (
        <div className="mt-4 grid gap-3 md:grid-cols-3">
          <Stat label="Связь" value={RELATION[v.relation] ?? v.relation} />
          <Stat label="Актуальность" value={v.actuality ? ACTUALITY[v.actuality] : "—"} />
          <Stat label="Уверенность" value={pct(v.confidence)} bar={v.confidence} />
        </div>
      )}
      {v?.jev && (
        <div className="mt-3 rounded-lg bg-raised p-3 text-xs">
          <div className="mb-2 text-faint">Вероятности Jev ({v.jev.model})</div>
          <Bars data={v.jev.relation} labels={RELATION} />
          <div className="my-2 border-t border-line" />
          <Bars data={v.jev.actuality} labels={ACTUALITY} />
        </div>
      )}
      {f.kind === "no-doc" && <p className="mt-4 text-sm text-dim">Ни один документ не похож на этот кейс по тексту: возможно, документации нет или кейс устарел.</p>}
      {f.kind === "no-case" && <p className="mt-4 text-sm text-dim">Ни один кейс не похож на этот документ по тексту: возможно, функциональность не покрыта тестами.</p>}
      {f.error && <p className="mt-4 text-sm text-bad">{f.error}</p>}
      {v?.explanation && <p className="mt-4 text-sm leading-relaxed">{v.explanation}</p>}
      {!!v?.issues.length && (
        <ul className="mt-3 space-y-2">
          {v.issues.map((i, n) => (
            <li key={n} className="rounded-lg border border-line p-3 text-sm">
              <div>{i.summary}</div>
              {i.suggestion && <div className="mt-1 text-dim">→ {i.suggestion}</div>}
            </li>
          ))}
        </ul>
      )}
      {v && !v.explanation && v.engine === "jev" && (
        <p className="mt-4 text-xs text-faint">Jev не пишет текст. Отправьте отчёт в чат, чтобы агент объяснил расхождение.</p>
      )}

      {ctx && (
        <details className="mt-5" open={f.kind !== "no-case"}>
          <summary className="cursor-pointer text-sm text-dim">Исходные тексты</summary>
          <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-raised p-3 font-sans text-xs leading-relaxed text-dim">
            {ctx.text.slice(ctx.text.indexOf("## ") >= 0 ? ctx.text.indexOf("## ") : 0)}
          </pre>
        </details>
      )}
    </div>
  );
}

function EngineButton({ on, disabled, onClick, icon, label, hint }: {
  on: boolean; disabled?: boolean; onClick(): void; icon: ReactNode; label: string; hint: string;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`flex items-center gap-2 rounded-md px-3 py-1.5 text-left disabled:opacity-40 ${on ? "bg-accent-soft text-ink" : "text-dim hover:text-ink"}`}>
      {icon}
      <span>
        <span className="block text-sm">{label}</span>
        <span className="block max-w-48 truncate text-[11px] text-faint">{hint}</span>
      </span>
    </button>
  );
}

function Chip({ on, onClick, children }: { on: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button onClick={onClick} className={`flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs ${on ? "border-accent bg-accent-soft" : "border-line text-dim hover:text-ink"}`}>
      {children}
    </button>
  );
}

function Source({ label, title, sub, url }: { label: string; title: string; sub?: string; url?: string }) {
  return (
    <div className="rounded-lg bg-raised p-3">
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-0.5">{title}</div>
      {sub && <div className="truncate text-xs text-faint">{sub}</div>}
      {url && <a href={url} target="_blank" rel="noreferrer" className="mt-1 inline-flex items-center gap-1 text-xs text-accent">Открыть в источнике <ExternalLink size={11} /></a>}
    </div>
  );
}

function Stat({ label, value, bar }: { label: string; value: string; bar?: number }) {
  return (
    <div className="rounded-lg bg-raised p-3">
      <div className="text-xs text-faint">{label}</div>
      <div className="mt-0.5 text-sm">{value}</div>
      {bar !== undefined && (
        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-line">
          <div className={`h-full ${bar >= 0.7 ? "bg-ok" : bar >= 0.4 ? "bg-warn" : "bg-bad"}`} style={{ width: pct(bar) }} />
        </div>
      )}
    </div>
  );
}

function Bars({ data, labels }: { data: Record<string, number>; labels: Record<string, string> }) {
  return (
    <div className="space-y-1">
      {Object.entries(data).map(([k, p]) => (
        <div key={k} className="flex items-center gap-2">
          <span className="w-32 shrink-0 text-dim">{labels[k] ?? k}</span>
          <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-line"><div className="h-full bg-accent" style={{ width: pct(p) }} /></div>
          <span className="w-10 text-right text-faint">{pct(p)}</span>
        </div>
      ))}
    </div>
  );
}
