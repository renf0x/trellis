import { useCallback, useEffect, useState } from "react";
import { Check, CloudDownload, ExternalLink, PlugZap, Search, X } from "lucide-react";
import type { ModuleUiProps, SourceInfo } from "@trellis/core";
import { Block } from "@trellis/ui";

type Api = ModuleUiProps["api"];
const base = "/api/m/connector-jira";

interface CheckStep { id: string; title: string; ok: boolean; message: string }
interface CheckResult { ok: boolean; cloud: boolean; user?: string; steps: CheckStep[]; at?: string }
interface SettingsResponse {
  baseUrl: string; email: string; project: string; docsJql: string; casesJql: string;
  lastCheck?: CheckResult; cloud: boolean | null; hasToken: boolean; tokenHint?: string; tokenFromEnv: boolean;
}
interface Job { phase: string; message: string; docs: number; cases: number; warnings: string[]; running: boolean }
interface Issue { key: string; summary?: string; status?: string; type?: string; url: string }

const card = "rounded-xl border border-line bg-panel p-4";
const input = "h-9 w-full rounded-lg border border-line bg-raised px-3 text-sm outline-none focus:border-accent";
const btn = "flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm disabled:opacity-40";
const cloudHost = (u: string) => /\.(atlassian\.net|jira\.com)(\/|$)/i.test(u) || /^[a-z0-9-]+$/i.test(u.trim());

export default function Jira({ api, navigate }: ModuleUiProps) {
  const [s, setS] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<SettingsResponse>(`${base}/settings`).then(setS, (e: Error) => setError(e.message)), [api]);
  useEffect(() => void load(), [load]);

  if (!s) return <p className="text-dim">{error ?? "Загрузка…"}</p>;
  const ready = !!s.lastCheck?.steps.find((x) => x.id === "project")?.ok;
  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">Jira</h1>
      <Block id="connector-jira/connection" title="Jira · Подключение"><Connection api={api} s={s} onSaved={load} /></Block>
      {ready && <Block id="connector-jira/sync" title="Jira · Загрузка в приложение"><Sync api={api} navigate={navigate} /></Block>}
      {ready && <Block id="connector-jira/preview" title="Jira · Проверить JQL"><Preview api={api} s={s} /></Block>}
    </div>
  );
}

function Connection({ api, s, onSaved }: { api: Api; s: SettingsResponse; onSaved: () => void }) {
  const [f, setF] = useState({ baseUrl: s.baseUrl, email: s.email, project: s.project, docsJql: s.docsJql, casesJql: s.casesJql, token: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cloud = cloudHost(f.baseUrl);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function saveAndCheck() {
    setBusy(true);
    setError(null);
    try {
      const { token, ...rest } = f;
      await api.post(`${base}/settings`, token ? f : rest);
      await api.post(`${base}/test`);
      setF((x) => ({ ...x, token: "" }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      onSaved();
    }
  }

  const c = s.lastCheck;
  return (
    <section className={card}>
      <div className="flex items-center gap-2">
        <PlugZap size={18} />
        <h2 className="font-semibold">Подключение</h2>
        {c && <span className={`ml-auto text-xs ${c.ok ? "text-ok" : "text-warn"}`}>{c.ok ? "Подключено" : "Есть проблемы"}{c.user ? ` · ${c.user}` : ""}</span>}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Field label="Адрес Jira" hint="mysite, mysite.atlassian.net или адрес своего сервера (https://jira.company.ru)">
          <input value={f.baseUrl} onChange={set("baseUrl")} placeholder="mysite.atlassian.net" className={input} />
        </Field>
        <Field label="Ключ проекта" hint="Латиницей, как в номерах задач: QA-123 → QA">
          <input value={f.project} onChange={set("project")} placeholder="QA" className={input} />
        </Field>
        {cloud && (
          <Field label="Email учётной записи" hint="Для Jira Cloud токен работает только вместе с email">
            <input value={f.email} onChange={set("email")} placeholder="name@company.com" className={input} />
          </Field>
        )}
        <Field label={cloud ? "API-токен" : "Personal access token"}
          hint={s.tokenFromEnv ? "Задан переменной JIRA_TOKEN" : s.hasToken ? `Сохранён (${s.tokenHint}). Оставьте пустым, чтобы не менять` : cloud
            ? "id.atlassian.com → Security → API tokens" : "Профиль в Jira → Personal Access Tokens"}>
          <input type="password" value={f.token} onChange={set("token")} autoComplete="off" placeholder={s.hasToken ? "••••••••" : ""} className={input} />
        </Field>
        <Field label="JQL: документация" hint="Требования, истории, эпики. По умолчанию все задачи проекта">
          <input value={f.docsJql} onChange={set("docsJql")} placeholder={f.project ? `project = ${f.project.toUpperCase()} ORDER BY key` : ""} className={input} />
        </Field>
        <Field label="JQL: тест-кейсы" hint="Например issuetype = Test. Пусто: кейсы из Jira не загружаются">
          <input value={f.casesJql} onChange={set("casesJql")} placeholder="project = QA AND issuetype = Test" className={input} />
        </Field>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => void saveAndCheck()} disabled={busy || !f.baseUrl || !f.project} className={`${btn} bg-accent`}>
          <Check size={15} /> {busy ? "Проверяю…" : "Сохранить и проверить"}
        </button>
        {error && <span className="text-sm text-bad">{error}</span>}
      </div>
      {c && (
        <ul className="mt-3 space-y-1.5">
          {c.steps.map((st) => (
            <li key={st.id} className="flex gap-2 text-sm">
              {st.ok ? <Check size={16} className="mt-0.5 shrink-0 text-ok" /> : <X size={16} className="mt-0.5 shrink-0 text-bad" />}
              <span className="w-40 shrink-0 text-dim">{st.title}</span>
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
        <button disabled={!!job?.running}
          onClick={() => api.post(`${base}/sync`).then(load, (e: Error) => setError(e.message))}
          className={`${btn} ml-auto bg-accent`}>
          <CloudDownload size={15} /> {job?.running ? "Загружаю…" : "Загрузить из Jira"}
        </button>
      </div>
      <p className="mt-2 text-sm text-dim">
        Задачи по JQL документации попадают в «Документацию» (описание как Markdown), по JQL тест-кейсов — в «Тест-кейсы».
        Шаги берутся из описания: таблица «шаг | ожидаемый результат» или нумерованный список. Повторная загрузка заменяет прежнюю копию.
      </p>
      {st?.source && (
        <p className="mt-2 text-xs text-faint">
          Сейчас в приложении: {st.source.docs} задач в документации, {st.source.cases} тест-кейсов · {new Date(st.source.syncedAt).toLocaleString()}
          {" · "}<button onClick={() => navigate("docs-view")} className="text-accent">Документация</button>
          {" · "}<button onClick={() => navigate("testcases-view")} className="text-accent">Тест-кейсы</button>
        </p>
      )}
      {job && <p className={`mt-2 text-sm ${job.phase === "error" ? "text-bad" : job.phase === "done" ? "text-ok" : "text-dim"}`}>{job.message}</p>}
      {job?.warnings.map((w, i) => <p key={i} className="text-xs text-warn">{w}</p>)}
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
    </section>
  );
}

function Preview({ api, s }: { api: Api; s: SettingsResponse }) {
  const [jql, setJql] = useState(s.docsJql);
  const [items, setItems] = useState<Issue[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = () => {
    setError(null);
    api.get<Issue[]>(`${base}/issues?jql=${encodeURIComponent(jql)}`).then(setItems, (e: Error) => (setItems(null), setError(e.message)));
  };
  return (
    <section className={card}>
      <div className="flex items-center gap-2">
        <Search size={18} />
        <h2 className="font-semibold">Проверить JQL</h2>
      </div>
      <div className="mt-3 flex gap-2">
        <input value={jql} onChange={(e) => setJql(e.target.value)} onKeyDown={(e) => e.key === "Enter" && run()} className={input} />
        <button onClick={run} disabled={!jql.trim()} className={`${btn} border border-line`}>Показать</button>
      </div>
      {error && <p className="mt-2 text-sm text-bad">{error}</p>}
      {items && (
        <div className="mt-3 text-sm">
          <div className="mb-1 text-xs text-faint">Первые {items.length}</div>
          {items.map((i) => (
            <a key={i.key} href={i.url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-raised">
              <span className="w-24 shrink-0 text-faint">{i.key}</span>
              <span className="flex-1 truncate">{i.summary}</span>
              <span className="text-xs text-dim">{i.type} · {i.status}</span>
              <ExternalLink size={12} className="text-faint" />
            </a>
          ))}
        </div>
      )}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs text-dim">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <span className="mt-1 block text-[11px] text-faint">{hint}</span>}
    </label>
  );
}
