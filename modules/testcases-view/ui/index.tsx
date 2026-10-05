import { useEffect, useState } from "react";
import { ClipboardPlus, CloudDownload, ExternalLink, MessageSquarePlus, Play, Search, TriangleAlert, X } from "lucide-react";
import type { ModuleUiProps, SourceInfo, TestCaseRecord } from "@trellis/core";
import { openInWorkChat } from "@trellis/ui";
import { NoDocs, VIEW_KEY, type View } from "./nodocs.tsx";

type Row = Omit<TestCaseRecord, "steps"> & { stepCount: number; noExpected: boolean };
interface ListResponse { sources: SourceInfo[]; total: number; states: string[]; suites: string[]; items: Row[] }

const base = "/api/m/testcases-view";
const control = "h-9 rounded-lg border border-line bg-raised px-3 text-sm outline-none focus:border-accent";

function caseText(c: TestCaseRecord) {
  const steps = c.steps.map((s, i) => (s.kind === "shared" ? `${i + 1}. [общие шаги] ${s.action}` : `${i + 1}. ${s.action}\n   Ожидается: ${s.expected || "—"}`));
  const description = c.description?.trim() ? `\nОписание: ${c.description.trim()}\n` : "";
  return `Тест-кейс (id: ${c.id})\n#${c.externalId} ${c.title}\nСтатус: ${c.state}\nНаборы: ${c.suites.join("; ")}\n${description}\n${steps.join("\n") || "(нет шагов)"}`;
}

const URL_KEY = "trellis.testrun.url";
const load = (key: string) => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const save = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* storage blocked: only the choice is lost */ }
};

/** The prompt put into the chat for a run: the case itself goes as the attachment. */
export function runPrompt(c: TestCaseRecord, url: string) {
  const where = url ? `по адресу ${url}` : "(адрес возьми из кейса; если его нет нигде — спроси меня)";
  return [
    `Пройди тест-кейс #${c.externalId} «${c.title}» в браузере ${where}.`,
    "",
    "1. Прочитай кейс целиком: название, описание, предусловия, шаги. Условия среды из него (ширина экрана, мобильная или планшетная "
      + "версия, несколько разрешений) выставь сам действием viewport до первого шага; несколько размеров — пройди проверки на каждом.",
    "2. Проходи шаги по порядку без подтверждений: действия — блоками trellis-browser, ожидаемый результат каждого шага — через verify. "
      + "После шага коротко: что сделал и что увидел. Не проси меня выполнять шаги или править кейс.",
    "3. Спрашивай, только если без данных шаг невозможен (например, нужен логин и пароль) — тогда коротко спроси и жди. "
      + "Остальные неясности трактуй разумно, действуй и запиши трактовку в замечания.",
    "4. Элемента нет, страница выглядит иначе или результат не совпадает — screenshot, статус «не пройден», иди дальше; "
      + "шаги, которые от него зависят, — «заблокирован». Для проверок вёрстки и ошибок смотри снимок (горизонтальная прокрутка) и console.",
    "",
    "Итоговый отчёт (не останавливайся, пока его не напишешь):",
    "- таблица «№ | действие | ожидается | факт | статус» (пройден / не пройден / заблокирован / не проверен);",
    "- общий статус прогона и условия (адрес, размер экрана);",
    "- замечания: дефекты, ошибки консоли, расхождения кейса с текущим сайтом, отсутствующие элементы, неполные шаги и твои трактовки;",
    "- что поправить в кейсе (если правка ясна — блоком trellis-change).",
  ].join("\n");
}

export default function TestCasesView({ api, navigate }: ModuleUiProps) {
  const [view, setView] = useState<View>(() => (load(VIEW_KEY) === "nodocs" ? "nodocs" : "all"));
  const [noDocsCount, setNoDocsCount] = useState<number | null>(null);
  const [runUrl, setRunUrl] = useState(() => load(URL_KEY) ?? "");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [state, setState] = useState("");
  const [suite, setSuite] = useState("");
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<TestCaseRecord | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    const p = new URLSearchParams({ q: query, state, suite });
    api.get<ListResponse>(`${base}/cases?${p}`).then(setData, (e: Error) => setError(e.message));
  }, [api, query, state, suite]);
  useEffect(() => {
    if (!selected) return setDetail(null);
    api.get<TestCaseRecord>(`${base}/case?id=${encodeURIComponent(selected)}`).then(setDetail, (e: Error) => setError(e.message));
  }, [api, selected]);

  useEffect(() => {
    api.get<{ summary: { undocumented: number; partial: number } }>("/api/m/compare/case-docs").then(
      (r) => setNoDocsCount(r.summary.undocumented + r.summary.partial), () => setNoDocsCount(null));
  }, [api]);
  const switchView = (v: View) => {
    setView(v);
    save(VIEW_KEY, v);
  };

  /** Opens a new tab of the workbench chat with the case attached and the run prompt in the input, not sent. */
  async function runTest(c: TestCaseRecord) {
    try {
      await api.get("/api/m/test-runner/status");
    } catch {
      return setError("Модуль «Прогон тестов в браузере» выключен: включите его в настройках");
    }
    const url = runUrl.trim();
    if (url && !/^https?:\/\//i.test(url)) return setError("Адрес должен начинаться с http:// или https://");
    save(URL_KEY, url);
    openInWorkChat({ kind: "run", key: `run:${c.id}`, title: `Прогон #${c.externalId} ${c.title}` },
      { title: `Кейс #${c.externalId} ${c.title}`, text: caseText(c) }, { draft: runPrompt(c, url), fresh: true });
  }

  /** Opens a draft edit of the case on the workbench (the existing draft, if there is one). */
  async function toWork(caseId: string) {
    try {
      const it = await api.post<{ id: string }>("/api/m/workbench/items", { kind: "edit", caseId });
      try {
        localStorage.setItem("trellis.workbench.open", it.id);
      } catch {
        /* the workbench just opens without a selection */
      }
      navigate("workbench");
    } catch (e) {
      setError(/404|not found/i.test((e as Error).message) ? "Модуль «Рабочее место» выключен: включите его в настройках" : (e as Error).message);
    }
  }

  if (!data) return <p className="text-dim">{error ?? "Загрузка…"}</p>;
  if (!data.total) return <Empty navigate={navigate} />;

  const tab = (v: View, label: string) => (
    <button onClick={() => switchView(v)}
      className={`rounded-md px-3 py-1.5 text-sm ${view === v ? "bg-raised text-ink" : "text-dim hover:text-ink"}`}>{label}</button>
  );

  return (
    <div className="flex h-full min-h-0 gap-4">
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-line bg-panel">
        <nav className="flex gap-1 border-b border-line p-2">
          {tab("all", `Все кейсы (${data.total})`)}
          {tab("nodocs", `Тесты без документации${noDocsCount === null ? "" : ` (${noDocsCount})`}`)}
        </nav>
        {view === "nodocs" ? <NoDocs api={api} navigate={navigate} selected={selected} onSelect={setSelected} /> : <>
        <div className="flex flex-wrap gap-2 p-3">
          <label className={`${control} flex min-w-60 flex-1 items-center gap-2 text-dim`}>
            <Search size={15} />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="ID, название или текст шагов"
              className="flex-1 bg-transparent outline-none placeholder:text-faint" />
          </label>
          <select value={state} onChange={(e) => setState(e.target.value)} className={control}>
            <option value="">Все статусы</option>
            {data.states.map((s) => <option key={s}>{s}</option>)}
          </select>
          <select value={suite} onChange={(e) => setSuite(e.target.value)} className={`${control} max-w-80`}>
            <option value="">Все наборы</option>
            {data.suites.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
        <div className="px-3 pb-2 text-xs text-faint">Показано {data.items.length} из {data.total}</div>
        <div className="min-h-0 flex-1 overflow-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-panel text-left text-xs text-faint">
              <tr>
                <th className="px-3 py-2 font-normal">ID</th>
                <th className="px-3 py-2 font-normal">Название</th>
                <th className="px-3 py-2 font-normal">Статус</th>
                <th className="px-3 py-2 font-normal">Приоритет</th>
                <th className="px-3 py-2 font-normal">Шаги</th>
                <th className="px-3 py-2 font-normal">Набор</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((c) => (
                <tr key={c.id} onClick={() => setSelected(c.id)}
                  className={`cursor-pointer border-t border-line ${selected === c.id ? "bg-accent-soft" : "hover:bg-raised"}`}>
                  <td className="px-3 py-2 text-faint">{c.externalId}</td>
                  <td className="px-3 py-2">{c.title}</td>
                  <td className="px-3 py-2 text-dim">{c.state}</td>
                  <td className="px-3 py-2 text-dim">{c.priority ?? "—"}</td>
                  <td className="px-3 py-2 text-dim">
                    <span className="inline-flex items-center gap-1">
                      {c.stepCount}
                      {(c.stepCount === 0 || c.noExpected) && (
                        <span title={c.stepCount === 0 ? "Нет шагов" : "Есть шаги без ожидаемого результата"}>
                          <TriangleAlert size={13} className="text-warn" />
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="max-w-72 truncate px-3 py-2 text-xs text-faint" title={c.suites.join("\n")}>{c.suites[0]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>}
      </section>
      {detail && (
        <aside className="w-[440px] shrink-0 overflow-auto rounded-xl border border-line bg-panel p-4">
          <div className="flex items-start gap-2">
            <div className="flex-1">
              <div className="text-xs text-faint">#{detail.externalId} · {detail.state}{detail.priority ? ` · P${detail.priority}` : ""}</div>
              <h2 className="mt-1 text-lg font-semibold">{detail.title}</h2>
            </div>
            <button onClick={() => setSelected(null)} className="text-faint hover:text-ink"><X size={18} /></button>
          </div>
          <div className="mt-2 space-y-0.5 text-xs text-faint">{detail.suites.map((s) => <div key={s}>{s}</div>)}</div>
          <div className="mt-2 flex gap-3 text-xs">
            <button onClick={() => openInWorkChat({ kind: "case", key: `case:${detail.id}`, title: `#${detail.externalId} ${detail.title}` },
              { title: `Кейс #${detail.externalId} ${detail.title}`, text: caseText(detail) })}
              title="Открыть кейс во вкладке чата «Рабочего места»: обсудить его и попросить правку" className="inline-flex items-center gap-1 text-accent">
              <MessageSquarePlus size={12} /> В чат
            </button>
            <button onClick={() => void toWork(detail.id)} title="Черновик правки этого кейса на рабочем месте"
              className="inline-flex items-center gap-1 text-accent">
              <ClipboardPlus size={12} /> В работу
            </button>
            {detail.url && (
              <a href={detail.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent">
                Открыть в источнике <ExternalLink size={12} />
              </a>
            )}
          </div>
          <div className="mt-3 rounded-lg border border-line p-2">
            <div className="flex gap-2">
              <input value={runUrl} onChange={(e) => setRunUrl(e.target.value)} placeholder="Адрес сайта для прогона (если изменился)"
                className="h-8 min-w-0 flex-1 rounded-md border border-line bg-raised px-2 text-xs outline-none focus:border-accent" />
              <button onClick={() => void runTest(detail)}
                title="Новая вкладка чата «Рабочего места»: кейс приложен, задание на прохождение в поле ввода — проверьте и отправьте"
                className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md bg-accent px-2 text-xs">
                <Play size={12} /> Пройти тест
              </button>
            </div>
            <div className="mt-1 text-[11px] text-faint">Агент пройдёт шаги в браузере (Edge, Chrome или другой Chromium): сам выставит размер экрана из кейса (например, 360 px), посмотрит консоль и напишет отчёт с замечаниями.</div>
          </div>
          {error && <p className="mt-2 text-xs text-bad">{error}</p>}
          {detail.description && (
            <div className="mt-4 whitespace-pre-wrap rounded-lg bg-raised p-3 text-sm">
              <div className="mb-1 text-xs text-faint">Описание</div>
              {detail.description}
            </div>
          )}
          <ol className="mt-4 space-y-3">
            {detail.steps.length === 0 && <p className="text-sm text-warn">У кейса нет шагов.</p>}
            {detail.steps.map((s, i) => (
              <li key={i} className="rounded-lg bg-raised p-3 text-sm">
                <div className="text-xs text-faint">Шаг {i + 1}{s.kind === "shared" ? " · общие шаги" : ""}</div>
                <div className="mt-1 whitespace-pre-wrap">{s.action}</div>
                {s.kind === "step" && (
                  <div className={`mt-2 whitespace-pre-wrap border-l-2 pl-2 ${s.expected ? "border-ok/60 text-dim" : "border-warn/60 text-warn"}`}>
                    {s.expected || "Ожидаемый результат не указан"}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </aside>
      )}
    </div>
  );
}

function Empty({ navigate }: { navigate: (id: string) => void }) {
  return (
    <section className="max-w-xl rounded-xl border border-line bg-panel p-8">
      <h1 className="text-xl font-semibold">Тест-кейсы</h1>
      <p className="mt-2 text-dim">Кейсов пока нет. Подключите Qase и загрузите кейсы в приложение.</p>
      <button onClick={() => navigate("connector-qase")} className="mt-4 flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm">
        <CloudDownload size={16} /> Перейти к Qase
      </button>
    </section>
  );
}
