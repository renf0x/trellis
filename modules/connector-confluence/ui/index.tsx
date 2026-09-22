import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Check, CloudDownload, FolderOpen, PlugZap, X } from "lucide-react";
import type { ModuleUiProps, SourceInfo } from "@trellis/core";
import { Block } from "@trellis/ui";

type Api = ModuleUiProps["api"];
const base = "/api/m/connector-confluence";

interface CheckStep { id: string; title: string; ok: boolean; message: string }
interface CheckResult { ok: boolean; cloud: boolean; user?: string; steps: CheckStep[]; at?: string }
interface SettingsResponse {
  baseUrl: string; email: string; spaces: string[]; cloud: boolean | null; lastCheck?: CheckResult;
  hasToken: boolean; tokenHint?: string; tokenFromEnv: boolean;
}
interface Job { phase: string; message: string; docs: number; warnings: string[]; running: boolean }

const card = "rounded-xl border border-line bg-panel p-4";
const input = "h-9 w-full rounded-lg border border-line bg-raised px-3 text-sm outline-none focus:border-accent";
const btn = "flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm disabled:opacity-40";
const cloudHost = (url: string) => /\.(atlassian\.net|jira\.com)(\/|$)/i.test(url) || /^[a-z0-9-]+$/i.test(url.trim());

export default function Confluence({ api, navigate }: ModuleUiProps) {
  const [s, setS] = useState<SettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<SettingsResponse>(`${base}/settings`).then(setS, (e: Error) => setError(e.message)), [api]);
  useEffect(() => void load(), [load]);

  if (!s) return <p className="text-dim">{error ?? "Загрузка…"}</p>;
  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">Confluence</h1>
      <Block id="connector-confluence/connection" title="Confluence · Подключение"><Connection api={api} s={s} onSaved={load} /></Block>
      {s.lastCheck?.ok && <Block id="connector-confluence/sync" title="Confluence · Загрузка в приложение"><Sync api={api} navigate={navigate} /></Block>}
    </div>
  );
}

function Connection({ api, s, onSaved }: { api: Api; s: SettingsResponse; onSaved: () => void }) {
  const [f, setF] = useState({ baseUrl: s.baseUrl, email: s.email, spaces: s.spaces.join(", "), token: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [spaces, setSpaces] = useState<{ key: string; name: string }[] | null>(null);
  const cloud = f.baseUrl ? cloudHost(f.baseUrl) : true;
  const chosen = f.spaces.split(/[\s,;]+/).filter(Boolean);

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
  async function listSpaces() {
    setError(null);
    try {
      await save();
      setSpaces(await api.get(`${base}/spaces`));
    } catch (e) {
      setError((e as Error).message);
    }
  }
  const toggle = (key: string) =>
    setF({ ...f, spaces: (chosen.includes(key) ? chosen.filter((k) => k !== key) : [...chosen, key]).join(", ") });

  const c = s.lastCheck;
  return (
    <section className={card}>
      <div className="flex items-center gap-2">
        <PlugZap size={18} />
        <h2 className="font-semibold">Подключение</h2>
        {c && <span className={`ml-auto text-xs ${c.ok ? "text-ok" : "text-warn"}`}>{c.ok ? `Подключено${c.user ? ` · ${c.user}` : ""}` : "Есть проблемы"}</span>}
      </div>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <Field label="Адрес Confluence" hint="Cloud: mysite или https://mysite.atlassian.net/wiki. Server: https://wiki.company.ru (с путём, если он есть)">
          <input value={f.baseUrl} onChange={(e) => setF({ ...f, baseUrl: e.target.value })} placeholder="mysite.atlassian.net" className={input} />
        </Field>
        {cloud && (
          <Field label="Email учётной записи" hint="Только для Cloud: тот же, что при входе в Atlassian">
            <input value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="off" className={input} />
          </Field>
        )}
        <Field label={cloud ? "API-токен" : "Персональный токен (PAT)"} hint={s.tokenFromEnv ? "Задан переменной CONFLUENCE_TOKEN" : s.hasToken
          ? `Сохранён (${s.tokenHint}). Оставьте пустым, чтобы не менять`
          : cloud ? "id.atlassian.com → Security → API tokens (подходит тот же токен, что для Jira)" : "Confluence → профиль → Personal Access Tokens"}>
          <input type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} autoComplete="off"
            placeholder={s.hasToken ? "••••••••" : ""} className={input} />
        </Field>
        <Field label="Пространства" hint="Ключи через запятую, как в адресе …/spaces/KEY/… Или выберите из списка">
          <div className="flex gap-2">
            <input value={f.spaces} onChange={(e) => setF({ ...f, spaces: e.target.value })} placeholder="QA, DOCS" className={input} />
            <button onClick={() => void listSpaces()} disabled={!f.baseUrl} title="Показать пространства, доступные токену"
              className={`${btn} shrink-0 border border-line text-dim hover:text-ink`}>
              <FolderOpen size={15} /> Мои пространства
            </button>
          </div>
        </Field>
      </div>
      {spaces && (
        <div className="mt-3 flex max-h-48 flex-wrap gap-1.5 overflow-auto">
          {!spaces.length && <span className="text-sm text-faint">Токену не доступно ни одно пространство.</span>}
          {spaces.map((p) => (
            <button key={p.key} onClick={() => toggle(p.key)}
              className={`rounded-lg border px-2.5 py-1 text-sm ${chosen.includes(p.key) ? "border-accent bg-accent-soft" : "border-line text-dim hover:text-ink"}`}>
              {p.key} <span className="text-faint">{p.name}</span>
            </button>
          ))}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => void saveAndCheck()} disabled={busy || !f.baseUrl || !chosen.length} className={`${btn} bg-accent`}>
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
        <button disabled={!!job?.running} onClick={() => api.post(`${base}/sync`).then(load, (e: Error) => setError(e.message))}
          className={`${btn} ml-auto bg-accent`}>
          <CloudDownload size={15} /> {job?.running ? "Загружаю…" : "Загрузить из Confluence"}
        </button>
      </div>
      <p className="mt-2 text-sm text-dim">
        Все страницы выбранных пространств попадают в «Документацию» с деревом страниц и ссылками на оригинал.
        Повторная загрузка заменяет прежнюю копию; при ошибке прежние данные остаются.
      </p>
      {st?.source && (
        <p className="mt-2 text-xs text-faint">
          Сейчас в приложении: {st.source.docs} страниц · {new Date(st.source.syncedAt).toLocaleString()}
          {" · "}<button onClick={() => navigate("docs-view")} className="text-accent">Документация</button>
          {" · "}<button onClick={() => navigate("compare")} className="text-accent">Сравнение</button>
        </p>
      )}
      {job && <p className={`mt-2 text-sm ${job.phase === "error" ? "text-bad" : job.phase === "done" ? "text-ok" : "text-dim"}`}>{job.message}</p>}
      {!!job?.warnings.length && <ul className="mt-1 list-disc pl-5 text-sm text-warn">{job.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
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
