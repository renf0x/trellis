import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, CloudDownload, FolderOpen, PlugZap, X } from "lucide-react";
import type { ModuleUiProps, SourceInfo } from "@trellis/core";
import { Block } from "@trellis/ui";

type Api = ModuleUiProps["api"];
const base = "/api/m/connector-qase";

interface CheckStep { id: string; title: string; ok: boolean; message: string }
interface CheckResult { ok: boolean; project?: string; steps: CheckStep[]; at?: string }
interface SettingsResponse {
  host: string; project: string; suitesAsDocs: boolean; lastCheck?: CheckResult;
  hasToken: boolean; tokenHint?: string; tokenFromEnv: boolean;
}
interface Job { phase: string; message: string; docs: number; cases: number; running: boolean }

const card = "rounded-xl border border-line bg-panel p-4";
const input = "h-9 w-full rounded-lg border border-line bg-raised px-3 text-sm outline-none focus:border-accent";
const btn = "flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm disabled:opacity-40";

export default function Qase({ api, navigate }: ModuleUiProps) {
  const [s, setS] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<SettingsResponse>(`${base}/settings`).then(setS, (e: Error) => setError(e.message)), [api]);
  useEffect(() => void load(), [load]);

  if (!s) return <p className="text-dim">{error ?? "Загрузка…"}</p>;
  const ready = !!s.lastCheck?.steps.find((x) => x.id === "project")?.ok;
  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">Qase</h1>
      <Block id="connector-qase/connection" title="Qase · Подключение"><Connection api={api} s={s} onSaved={load} /></Block>
      {ready && <Block id="connector-qase/sync" title="Qase · Загрузка в приложение"><Sync api={api} navigate={navigate} /></Block>}
    </div>
  );
}

function Connection({ api, s, onSaved }: { api: Api; s: SettingsResponse; onSaved: () => void }) {
  const [f, setF] = useState({ host: s.host, project: s.project, suitesAsDocs: s.suitesAsDocs, token: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ title: string; code: string }[] | null>(null);

  async function save() {
    const { token, ...rest } = f;
    await api.post(`${base}/settings`, token ? f : rest);
    setF((x) => ({ ...x, token: "" }));
  }
  async function saveAndCheck() {
    setBusy(true);
    setError(null);
    try {
      await save();
      await api.post(`${base}/test`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onSaved();
    }
  }
  async function listProjects() {
    setError(null);
    try {
      if (f.token) await save();
      setProjects(await api.get(`${base}/projects`));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const c = s.lastCheck;
  return (
    <section className={card}>
      <div className="flex items-center gap-2">
        <PlugZap size={18} />
        <h2 className="font-semibold">Подключение</h2>
        {c && <span className={`ml-auto text-xs ${c.ok ? "text-ok" : "text-warn"}`}>{c.ok ? `Подключено · ${c.project}` : "Есть проблемы"}</span>}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Field label="API-токен" hint={s.tokenFromEnv ? "Задан переменной QASE_TOKEN" : s.hasToken
          ? `Сохранён (${s.tokenHint}). Оставьте пустым, чтобы не менять` : "app.qase.io → аватар справа вверху → API tokens → Create a new API token"}>
          <input type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} autoComplete="off"
            placeholder={s.hasToken ? "••••••••" : ""} className={input} />
        </Field>
        <Field label="Код проекта" hint="Как в номерах кейсов: DEMO-12 → DEMO. Или выберите из списка">
          <div className="flex gap-2">
            <input value={f.project} onChange={(e) => setF({ ...f, project: e.target.value.toUpperCase() })} placeholder="DEMO" className={input} />
            <button onClick={() => void listProjects()} disabled={!s.hasToken && !f.token} title="Показать проекты, доступные токену"
              className={`${btn} shrink-0 border border-line text-dim hover:text-ink`}>
              <FolderOpen size={15} /> Мои проекты
            </button>
          </div>
        </Field>
        <Field label="Адрес API" hint="Для облачного Qase (и бесплатного тарифа) оставьте https://api.qase.io">
          <input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} className={input} />
        </Field>
        <label className="flex items-center gap-2 self-center text-sm text-dim">
          <input type="checkbox" checked={f.suitesAsDocs} onChange={(e) => setF({ ...f, suitesAsDocs: e.target.checked })} />
          Описания сьютов загружать в «Документацию»
        </label>
      </div>
      {projects && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {!projects.length && <span className="text-sm text-faint">Токену не доступен ни один проект.</span>}
          {projects.map((p) => (
            <button key={p.code} onClick={() => setF({ ...f, project: p.code })}
              className={`rounded-lg border px-2.5 py-1 text-sm ${f.project === p.code ? "border-accent bg-accent-soft" : "border-line text-dim hover:text-ink"}`}>
              {p.code} <span className="text-faint">{p.title}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => void saveAndCheck()} disabled={busy || !f.project || (!s.hasToken && !f.token)} className={`${btn} bg-accent`}>
          <Check size={15} /> {busy ? "Проверяю…" : "Сохранить и проверить"}
        </button>
        {error && <span className="text-sm text-bad">{error}</span>}
      </div>
      {c && (
        <ul className="mt-3 space-y-1.5">
          {c.steps.map((st) => (
            <li key={st.id} className="flex gap-2 text-sm">
              {st.ok ? <Check size={16} className="mt-0.5 shrink-0 text-ok" /> : <X size={16} className="mt-0.5 shrink-0 text-bad" />}
              <span className="w-24 shrink-0 text-dim">{st.title}</span>
              <span className={st.ok ? "" : "text-bad"}>{st.message}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Sync({ api, navigate }: { api: Api; navigate: (id: string) => void }) {
  const [st, setSt] = useState<{ job: Job | null; source: SourceInfo | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<{ job: Job | null; source: SourceInfo | null }>(`${base}/sync`).then(setSt), [api]);
  useEffect(() => void load(), [load]);
  useEffect(() => {
    if (!st?.job?.running) return;
    const t = setInterval(() => void load(), 1000);
    return () => clearInterval(t);
  }, [st?.job?.running, load]);

  const job = st?.job;
  return (
    <section className={card}>
      <div className="flex items-center gap-2">
        <CloudDownload size={18} />
        <h2 className="font-semibold">Загрузка в приложение</h2>
        <button disabled={!!job?.running} onClick={() => api.post(`${base}/sync`).then(load, (e: Error) => setError(e.message))}
          className={`${btn} ml-auto bg-accent`}>
          <CloudDownload size={15} /> {job?.running ? "Загружаю…" : "Загрузить из Qase"}
        </button>
      </div>
      <p className="mt-2 text-sm text-dim">
        Все кейсы проекта попадают в «Тест-кейсы» со своими шагами, ожидаемыми результатами, предусловиями и путём сьютов.
        Повторная загрузка заменяет прежнюю копию; при ошибке прежние данные остаются.
      </p>
      {st?.source && (
        <p className="mt-2 text-xs text-faint">
          Сейчас в приложении: {st.source.cases} тест-кейсов, {st.source.docs} описаний в документации · {new Date(st.source.syncedAt).toLocaleString()}
          {" · "}<button onClick={() => navigate("testcases-view")} className="text-accent">Тест-кейсы</button>
          {" · "}<button onClick={() => navigate("compare")} className="text-accent">Сравнение</button>
        </p>
      )}
      {job && <p className={`mt-2 text-sm ${job.phase === "error" ? "text-bad" : job.phase === "done" ? "text-ok" : "text-dim"}`}>{job.message}</p>}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-dim">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}
