import { useCallback, useEffect, useState, type ReactNode } from "react";
import { BookOpen, Check, CloudDownload, ChevronRight, CircleMinus, ClipboardList, ExternalLink, FileText, PlugZap, X } from "lucide-react";
import type { ModuleUiProps } from "@trellis/core";

type Api = ModuleUiProps["api"];
const base = "/api/m/connector-azure-devops";

interface CheckStep { id: string; title: string; ok: boolean | null; detail: string }
interface CheckResult { ok: boolean; apiVersion?: string; user?: string; steps: CheckStep[]; at: string }
interface SettingsResponse {
  baseUrl: string;
  project: string;
  apiVersion?: string;
  lastCheck?: CheckResult;
  hasPat: boolean;
  patHint?: string;
  patFromEnv: boolean;
}
interface WikiPage { path: string; subPages?: WikiPage[] }
interface Suite { id: number; name: string; parentSuite?: { id: number } }
interface TestCase {
  id: number; title: string; state: string; priority?: number; url?: string;
  steps: { kind: string; action: string; expected: string }[];
}

const card = "rounded-xl border border-line bg-panel p-4";
const input = "h-9 rounded-lg border border-line bg-raised px-3 text-sm outline-none focus:border-accent";
const btn = "flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm disabled:opacity-40";
const item = (on: boolean) =>
  `flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm ${on ? "bg-accent-soft text-ink" : "text-dim hover:bg-raised hover:text-ink"}`;

export default function AzureDevOps({ api }: ModuleUiProps) {
  const [s, setS] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<SettingsResponse>(`${base}/settings`).then(setS, (e: Error) => setError(e.message)), [api]);
  useEffect(() => void load(), [load]);

  if (!s) return <p className="text-dim">{error ?? "Загрузка…"}</p>;
  const ready = !!s.apiVersion && s.lastCheck?.steps.find((x) => x.id === "project")?.ok;
  return (
    <div className="max-w-6xl space-y-4">
      <h1 className="text-xl font-semibold">Azure DevOps</h1>
      <Connection api={api} s={s} onChange={load} />
      {ready && <Sync api={api} />}
      {ready ? (
        <div className="grid gap-4">
          <Wiki api={api} />
          <TestPlans api={api} />
        </div>
      ) : (
        <p className="text-sm text-faint">Wiki и тест-планы появятся здесь после успешной проверки подключения.</p>
      )}
    </div>
  );
}

function Connection({ api, s, onChange }: { api: Api; s: SettingsResponse; onChange: () => void }) {
  const [baseUrl, setBaseUrl] = useState(s.baseUrl);
  const [project, setProject] = useState(s.project);
  const [pat, setPat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = baseUrl !== s.baseUrl || project !== s.project || !!pat;

  const run = async (save: boolean) => {
    setBusy(true);
    setError(null);
    try {
      if (save || dirty) {
        await api.post(`${base}/settings`, { baseUrl, project, ...(pat ? { pat } : {}) });
        setPat("");
      }
      await api.post(`${base}/test`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onChange();
    }
  };
  const removePat = () => api.post(`${base}/settings`, { pat: "" }).then(onChange, (e: Error) => setError(e.message));
  const check = s.lastCheck;

  return (
    <section className={card}>
      <div className="flex items-center gap-2 font-semibold"><PlugZap size={16} /> Подключение</div>
      <div className="mt-3 grid gap-3 md:grid-cols-[2fr_1fr]">
        <label className="grid gap-1 text-xs text-dim">
          Организация или адрес коллекции
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} className={input}
            placeholder="my-org, https://dev.azure.com/my-org или https://tfs.company.ru/tfs/DefaultCollection" />
        </label>
        <label className="grid gap-1 text-xs text-dim">
          Проект
          <input value={project} onChange={(e) => setProject(e.target.value)} className={input} placeholder="Название проекта" />
        </label>
      </div>
      <label className="mt-3 grid gap-1 text-xs text-dim">
        Personal Access Token{" "}
        {s.hasPat ? `(сохранён ${s.patHint}${s.patFromEnv ? ", из AZURE_DEVOPS_PAT" : ""}; введите новый, чтобы заменить)` : "(не задан)"}
        <div className="flex gap-2">
          <input type="password" value={pat} onChange={(e) => setPat(e.target.value)} className={`${input} flex-1`}
            placeholder="Права: Wiki (Read), Test Management (Read), Work Items (Read)" autoComplete="off" />
          {s.hasPat && !s.patFromEnv && (
            <button onClick={removePat} className={`${btn} border border-line text-dim`}>Удалить PAT</button>
          )}
        </div>
      </label>
      <div className="mt-3 flex items-center gap-3">
        <button disabled={busy || !baseUrl.trim() || !project.trim()} onClick={() => run(true)} className={`${btn} bg-accent`}>
          {busy ? "Проверяю…" : dirty ? "Сохранить и проверить" : "Проверить подключение"}
        </button>
        {s.baseUrl && <span className="truncate text-xs text-faint">{s.baseUrl}</span>}
      </div>
      {error && <div className="mt-3 rounded-lg border border-bad/40 p-3 text-sm text-bad">{error}</div>}
      {check && (
        <div className="mt-4 space-y-1.5 border-t border-line pt-3">
          <div className="text-xs text-faint">
            Проверка {new Date(check.at).toLocaleString()}{check.apiVersion && ` · API ${check.apiVersion}`}
          </div>
          {check.steps.map((st) => (
            <div key={st.id} className="flex gap-2 text-sm">
              {st.ok === true ? <Check size={16} className="mt-0.5 shrink-0 text-ok" />
                : st.ok === false ? <X size={16} className="mt-0.5 shrink-0 text-bad" />
                : <CircleMinus size={16} className="mt-0.5 shrink-0 text-faint" />}
              <div><span className="font-medium">{st.title}.</span> <span className="text-dim">{st.detail}</span></div>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 text-xs text-faint">
        PAT хранится только в <code>data/secrets</code> и не отдаётся в браузер. Запись в Azure из приложения выключена.
      </p>
    </section>
  );
}

interface SyncJob { phase: string; message: string; docs: number; cases: number; warnings: string[]; running: boolean }
interface SyncState { job: SyncJob | null; source: { syncedAt: string; docs: number; cases: number } | null }

function Sync({ api }: { api: Api }) {
  const [st, setSt] = useState<SyncState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<SyncState>(`${base}/sync`).then(setSt, (e: Error) => setError(e.message)), [api]);
  useEffect(() => void load(), [load]);
  const running = !!st?.job?.running;
  useEffect(() => {
    if (!running) return;
    const t = setInterval(load, 1000);
    return () => clearInterval(t);
  }, [running, load]);
  const start = () => { setError(null); api.post(`${base}/sync`).then(load, (e: Error) => setError(e.message)); };
  const job = st?.job;

  return (
    <section className={card}>
      <div className="flex items-center gap-2 font-semibold"><CloudDownload size={16} /> Загрузка в приложение</div>
      <p className="mt-1 text-sm text-dim">
        Вся вики проекта попадает в «Документацию», все тест-планы в «Тест-кейсы». Повторная загрузка заменяет прежнюю копию.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button disabled={running} onClick={start} className={`${btn} bg-accent`}>{running ? "Загружаю…" : "Загрузить из Azure"}</button>
        {st?.source && (
          <span className="text-xs text-faint">
            В приложении: {st.source.docs} стр., {st.source.cases} кейсов · {new Date(st.source.syncedAt).toLocaleString()}
          </span>
        )}
      </div>
      {job && (
        <div className={`mt-3 text-sm ${job.phase === "error" ? "text-bad" : job.phase === "done" ? "text-ok" : "text-dim"}`}>
          {job.message}{job.running && ` (стр.: ${job.docs}, кейсов: ${job.cases})`}
        </div>
      )}
      {!!job?.warnings.length && (
        <details className="mt-2 text-xs text-warn">
          <summary className="cursor-pointer">Предупреждения: {job.warnings.length}</summary>
          <ul className="mt-1 list-disc space-y-0.5 pl-5">{job.warnings.slice(0, 50).map((w, i) => <li key={i}>{w}</li>)}</ul>
        </details>
      )}
      {error && <div className="mt-3 text-sm text-bad">{error}</div>}
    </section>
  );
}

function useLoad<T>(fn: (() => Promise<T>) | null, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!fn) return setData(null);
    let live = true;
    setLoading(true);
    setError(null);
    fn().then((d) => live && setData(d), (e: Error) => live && setError(e.message)).finally(() => live && setLoading(false));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading };
}

function Wiki({ api }: { api: Api }) {
  const wikis = useLoad(() => api.get<{ id: string; name: string }[]>(`${base}/wikis`), []);
  const [wikiId, setWikiId] = useState<string | null>(null);
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => {
    if (!wikiId && wikis.data?.length) setWikiId(wikis.data[0].id);
  }, [wikis.data, wikiId]);
  const tree = useLoad(wikiId ? () => api.get<WikiPage>(`${base}/wikis/${encodeURIComponent(wikiId)}/tree`) : null, [wikiId]);
  const page = useLoad(wikiId && path
    ? () => api.get<{ path: string; content: string; url?: string }>(`${base}/wikis/${encodeURIComponent(wikiId)}/page?path=${encodeURIComponent(path)}`)
    : null, [wikiId, path]);

  return (
    <section className={card}>
      <div className="flex items-center gap-2 font-semibold"><BookOpen size={16} /> Wiki</div>
      <Status {...wikis} empty={wikis.data?.length === 0 ? "В проекте нет вики." : null} />
      {!!wikis.data?.length && (
        <select value={wikiId ?? ""} onChange={(e) => { setWikiId(e.target.value); setPath(null); }} className={`${input} mt-3 w-full`}>
          {wikis.data.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
        </select>
      )}
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1.4fr]">
        <div className="max-h-[480px] overflow-auto">
          <Status {...tree} />
          {tree.data?.subPages?.map((p) => <PageNode key={p.path} page={p} selected={path} onSelect={setPath} />)}
        </div>
        <div className="max-h-[480px] overflow-auto rounded-lg bg-raised p-3">
          {!path && !!tree.data && <p className="text-sm text-faint">Выберите страницу.</p>}
          <Status {...page} />
          {page.data && (
            <>
              <div className="mb-2 flex items-center gap-2 text-xs text-faint">
                <FileText size={14} /> {page.data.path}
                {page.data.url && <a href={page.data.url} target="_blank" rel="noreferrer" className="ml-auto"><ExternalLink size={14} /></a>}
              </div>
              <pre className="whitespace-pre-wrap font-sans text-sm">{page.data.content || "Пустая страница."}</pre>
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function PageNode({ page, selected, onSelect, depth = 0 }: {
  page: WikiPage; selected: string | null; onSelect: (p: string) => void; depth?: number;
}) {
  const [open, setOpen] = useState(depth < 1);
  const name = page.path.split("/").pop() || page.path;
  const kids = page.subPages ?? [];
  return (
    <div>
      <button className={item(selected === page.path)} style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => { onSelect(page.path); if (kids.length) setOpen(!open); }}>
        {kids.length ? <ChevronRight size={14} className={open ? "rotate-90" : ""} /> : <span className="w-3.5" />}
        <span className="truncate">{name}</span>
      </button>
      {open && kids.map((k) => <PageNode key={k.path} page={k} selected={selected} onSelect={onSelect} depth={depth + 1} />)}
    </div>
  );
}

function TestPlans({ api }: { api: Api }) {
  const plans = useLoad(() => api.get<{ id: number; name: string; state?: string }[]>(`${base}/plans`), []);
  const [planId, setPlanId] = useState<number | null>(null);
  const [suiteId, setSuiteId] = useState<number | null>(null);
  useEffect(() => {
    if (!planId && plans.data?.length) setPlanId(plans.data[0].id);
  }, [plans.data, planId]);
  const suites = useLoad(planId ? () => api.get<Suite[]>(`${base}/plans/${planId}/suites`) : null, [planId]);
  const cases = useLoad(planId && suiteId ? () => api.get<TestCase[]>(`${base}/plans/${planId}/suites/${suiteId}/cases`) : null, [planId, suiteId]);

  return (
    <section className={card}>
      <div className="flex items-center gap-2 font-semibold"><ClipboardList size={16} /> Test Plans</div>
      <Status {...plans} empty={plans.data?.length === 0 ? "В проекте нет тест-планов." : null} />
      {!!plans.data?.length && (
        <select value={planId ?? ""} onChange={(e) => { setPlanId(Number(e.target.value)); setSuiteId(null); }} className={`${input} mt-3 w-full`}>
          {plans.data.map((p) => <option key={p.id} value={p.id}>{p.name}{p.state ? ` · ${p.state}` : ""}</option>)}
        </select>
      )}
      <div className="mt-3 grid gap-3 md:grid-cols-[1fr_1.4fr]">
        <div className="max-h-[480px] overflow-auto">
          <Status {...suites} />
          {suites.data && <SuiteTree suites={suites.data} selected={suiteId} onSelect={setSuiteId} />}
        </div>
        <div className="max-h-[480px] space-y-3 overflow-auto">
          {!suiteId && !!plans.data?.length && <p className="text-sm text-faint">Выберите набор.</p>}
          <Status {...cases} empty={cases.data?.length === 0 ? "В наборе нет кейсов." : null} />
          {cases.data?.map((c) => (
            <details key={c.id} className="rounded-lg bg-raised p-3">
              <summary className="cursor-pointer text-sm">
                <span className="text-faint">#{c.id}</span> {c.title}
                <span className="ml-2 text-xs text-faint">{c.state}{c.priority ? ` · P${c.priority}` : ""} · шагов: {c.steps.length}</span>
              </summary>
              <ol className="mt-2 space-y-2 text-sm">
                {c.steps.map((st, i) => (
                  <li key={i} className="grid grid-cols-[1.5rem_1fr] gap-1">
                    <span className="text-faint">{i + 1}.</span>
                    <div>
                      <div className="whitespace-pre-wrap">{st.action}</div>
                      {st.expected && <div className="whitespace-pre-wrap text-dim">→ {st.expected}</div>}
                    </div>
                  </li>
                ))}
              </ol>
              {c.url && <a href={c.url} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1 text-xs text-accent">Открыть в Azure <ExternalLink size={12} /></a>}
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}

function SuiteTree({ suites, selected, onSelect }: { suites: Suite[]; selected: number | null; onSelect: (id: number) => void }) {
  const ids = new Set(suites.map((s) => s.id));
  const children = (parent: number | undefined) =>
    suites.filter((s) => (parent === undefined ? !s.parentSuite || !ids.has(s.parentSuite.id) : s.parentSuite?.id === parent));
  const render = (list: Suite[], depth: number): ReactNode =>
    list.map((s) => (
      <div key={s.id}>
        <button className={item(selected === s.id)} style={{ paddingLeft: 8 + depth * 14 }} onClick={() => onSelect(s.id)}>
          <span className="truncate">{s.name}</span>
        </button>
        {render(children(s.id), depth + 1)}
      </div>
    ));
  return <>{render(children(undefined), 0)}</>;
}

function Status({ loading, error, empty }: { loading: boolean; error: string | null; empty?: string | null }) {
  if (loading) return <p className="mt-2 text-sm text-faint">Загрузка…</p>;
  if (error) return <p className="mt-2 text-sm text-bad">{error}</p>;
  if (empty) return <p className="mt-2 text-sm text-faint">{empty}</p>;
  return null;
}
