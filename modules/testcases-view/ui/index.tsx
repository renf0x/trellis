import { useEffect, useState } from "react";
import { CloudDownload, ExternalLink, Search, TriangleAlert, X } from "lucide-react";
import type { ModuleUiProps, SourceInfo, TestCaseRecord } from "@trellis/core";

type Row = Omit<TestCaseRecord, "steps"> & { stepCount: number; noExpected: boolean };
interface ListResponse { sources: SourceInfo[]; total: number; states: string[]; suites: string[]; items: Row[] }

const base = "/api/m/testcases-view";
const control = "h-9 rounded-lg border border-line bg-raised px-3 text-sm outline-none focus:border-accent";

export default function TestCasesView({ api, navigate }: ModuleUiProps) {
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

  if (!data) return <p className="text-dim">{error ?? "Загрузка…"}</p>;
  if (!data.total) return <Empty navigate={navigate} />;

  return (
    <div className="flex h-full min-h-0 gap-4">
      <section className="flex min-w-0 flex-1 flex-col rounded-xl border border-line bg-panel">
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
          {detail.url && (
            <a href={detail.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-accent">
              Открыть в источнике <ExternalLink size={12} />
            </a>
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
