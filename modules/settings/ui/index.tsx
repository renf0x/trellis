import { useCallback, useEffect, useState } from "react";
import { Bot, Check, KeyRound, LogIn, LogOut, MessagesSquare, RefreshCw, Sparkles, Zap } from "lucide-react";
import type { ChatBucket, ModuleUiProps } from "@trellis/core";
import { Block, type BucketSettings, type LlmSettingsResponse, type ProviderId } from "@trellis/ui";

interface GptModel {
  id: string;
  title: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
}
type Api = ModuleUiProps["api"];

const card = "rounded-xl border border-line bg-panel p-4";
const input = "h-9 rounded-lg border border-line bg-raised px-3 text-sm outline-none focus:border-accent";
const btn = "flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm disabled:opacity-40";

export default function Settings({ api }: ModuleUiProps) {
  const [data, setData] = useState<LlmSettingsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => api.get<LlmSettingsResponse>("/api/llm/settings").then(setData, (e: Error) => setError(e.message)), [api]);
  useEffect(() => void load(), [load]);

  if (!data) return <p className="text-dim">{error ?? "Загрузка настроек…"}</p>;
  return (
    <div className="max-w-5xl space-y-4">
      <h1 className="text-xl font-semibold">Настройки</h1>
      {error && <div className="rounded-lg border border-bad/40 p-3 text-sm text-bad">{error}</div>}
      <h2 className="text-sm text-dim">Подключения</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <Block id="settings/openrouter" title="Настройки · Ключ OpenRouter"><OpenRouterKey api={api} status={data.status} onChange={load} onError={setError} /></Block>
        <Block id="settings/chatgpt" title="Настройки · Подписка ChatGPT"><ChatGptAccount api={api} status={data.status} onChange={load} onError={setError} /></Block>
      </div>
      <h2 className="text-sm text-dim">Модели чатов (у каждого чата своя модель и своя статистика)</h2>
      <div className="grid gap-4 lg:grid-cols-2">
        <BucketCard bucket="main" title="Основной чат (AI QA агент)" icon={<Bot size={18} />} data={data} api={api} onSaved={load} />
        <Block id="settings/dev-chat" title="Настройки · Модель чата по доработкам">
          <BucketCard bucket="dev" title="Чат по доработкам" icon={<MessagesSquare size={18} />} data={data} api={api} onSaved={load} />
        </Block>
      </div>
      <h2 className="text-sm text-dim">Анализ документации и кейсов</h2>
      <Block id="settings/analysis" title="Настройки · Анализ (Jev)"><AnalysisCard data={data} api={api} onSaved={load} onError={setError} /></Block>
      <p className="text-xs text-faint">
        Ключи и токены хранятся только локально в <code>data/secrets</code> и не отдаются в браузер. Справочники статусов,
        источники (Confluence, Jira, Qase, локальные файлы) и срок хранения истории появятся здесь следующими задачами.
      </p>
    </div>
  );
}

function OpenRouterKey({ api, status, onChange, onError }: {
  api: Api; status: LlmSettingsResponse["status"]; onChange: () => void; onError: (e: string | null) => void;
}) {
  const [key, setKey] = useState("");
  const save = (apiKey: string) =>
    api.post("/api/llm/openrouter/key", { apiKey }).then(() => (setKey(""), onError(null), onChange()), (e: Error) => onError(e.message));
  return (
    <section className={card}>
      <div className="flex items-center gap-2 font-semibold"><KeyRound size={16} /> OpenRouter</div>
      <p className="mt-1 text-sm text-dim">
        {status.openrouter.hasKey ? <>Ключ сохранён: <code>{status.openrouter.keyHint}</code>{status.openrouter.fromEnv && " (из OPENROUTER_API_KEY)"}</> : "Ключ не задан."}
      </p>
      <div className="mt-3 flex gap-2">
        <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-or-v1-…" className={`${input} flex-1`} />
        <button disabled={!key.trim()} onClick={() => save(key)} className={`${btn} bg-accent`}>Сохранить</button>
        {status.openrouter.hasKey && !status.openrouter.fromEnv && (
          <button onClick={() => save("")} className={`${btn} border border-line text-dim`}>Удалить</button>
        )}
      </div>
    </section>
  );
}

function ChatGptAccount({ api, status, onChange, onError }: {
  api: Api; status: LlmSettingsResponse["status"]; onChange: () => void; onError: (e: string | null) => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const [pasted, setPasted] = useState("");
  const gpt = status.chatgpt;

  // While the browser tab is open on auth.openai.com, poll until the callback stores the tokens.
  useEffect(() => {
    if (!waiting) return;
    if (gpt.loggedIn) return void setWaiting(false);
    const t = setInterval(onChange, 2000);
    return () => clearInterval(t);
  }, [waiting, gpt.loggedIn, onChange]);

  const login = () =>
    api.post<{ url: string }>("/api/llm/chatgpt/login").then((r) => {
      onError(null);
      setWaiting(true);
      window.open(r.url, "_blank", "noopener");
    }, (e: Error) => onError(e.message));

  return (
    <section className={card}>
      <div className="flex items-center gap-2 font-semibold"><Zap size={16} /> ChatGPT по подписке</div>
      {gpt.loggedIn ? (
        <div className="mt-2 flex items-center gap-2 text-sm">
          <Check size={16} className="text-ok" />
          <span>{gpt.email ?? "Аккаунт подключён"}{gpt.plan && <span className="ml-2 rounded bg-raised px-1.5 text-xs uppercase text-dim">{gpt.plan}</span>}</span>
          <button onClick={() => api.post("/api/llm/chatgpt/logout").then(onChange)} className={`${btn} ml-auto border border-line text-dim`}>
            <LogOut size={14} /> Выйти
          </button>
        </div>
      ) : (
        <>
          <p className="mt-1 text-sm text-dim">Вход через аккаунт ChatGPT Plus/Pro/Business, как в Codex CLI и opencode. Запросы идут в счёт подписки.</p>
          <button onClick={login} className={`${btn} mt-3 bg-accent`}><LogIn size={14} /> {waiting ? "Открыть вход ещё раз" : "Войти через ChatGPT"}</button>
          {waiting && (
            <div className="mt-3 space-y-2 text-xs text-dim">
              <p>Завершите вход во вкладке браузера. Если после входа страница не открылась, скопируйте её адрес (localhost:1455/auth/callback?code=…) сюда:</p>
              <div className="flex gap-2">
                <input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="http://localhost:1455/auth/callback?code=…" className={`${input} flex-1`} />
                <button
                  disabled={!pasted.trim()}
                  onClick={() => api.post("/api/llm/chatgpt/callback", { url: pasted }).then(() => (setPasted(""), onChange()), (e: Error) => onError(e.message))}
                  className={`${btn} border border-line`}
                >
                  Готово
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function BucketCard({ bucket, title, icon, data, api, onSaved }: {
  bucket: ChatBucket; title: string; icon: React.ReactNode; data: LlmSettingsResponse; api: Api; onSaved: () => void;
}) {
  const [s, setS] = useState<BucketSettings>(data.settings[bucket]);
  const [models, setModels] = useState<{ models: GptModel[]; live: boolean; error?: string } | null>(null);
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => setS(data.settings[bucket]), [data, bucket]);

  const loadModels = useCallback(
    (refresh = false) => api.get<{ models: GptModel[]; live: boolean; error?: string }>(`/api/llm/chatgpt/models${refresh ? "?refresh=1" : ""}`).then(setModels, () => {}),
    [api],
  );
  useEffect(() => {
    if (s.provider === "chatgpt" && !models) void loadModels();
  }, [s.provider, models, loadModels]);

  const dirty = JSON.stringify(s) !== JSON.stringify(data.settings[bucket]);
  const orModel = s.openrouter.model.trim();
  const freeMismatch = orModel && orModel.endsWith(":free") !== s.openrouter.free;
  const gptModel = models?.models.find((m) => m.id === s.chatgpt.model) ?? (s.chatgpt.model ? undefined : models?.models[0]);
  const efforts = gptModel?.efforts.length ? gptModel.efforts : ["low", "medium", "high"];

  const save = () => api.patch(`/api/llm/settings/${bucket}`, s).then(onSaved);
  async function test() {
    setBusy(true);
    setNote(null);
    try {
      if (dirty) await save();
      const r = await api.post<{ text: string; meta?: { model: string } }>(`/api/llm/test/${bucket}`);
      setNote({ ok: true, text: `${r.meta?.model ?? ""}: «${r.text || "пустой ответ"}»` });
    } catch (e) {
      setNote({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }
  const setProvider = (provider: ProviderId) => setS({ ...s, provider });

  return (
    <section className={card}>
      <div className="flex items-center gap-2 font-semibold">{icon} {title}</div>
      <div className="mt-3 inline-flex rounded-lg border border-line p-0.5 text-sm">
        {(["openrouter", "chatgpt"] as const).map((p) => (
          <button key={p} onClick={() => setProvider(p)} className={`rounded-md px-3 py-1 ${s.provider === p ? "bg-accent text-ink" : "text-dim"}`}>
            {p === "openrouter" ? "OpenRouter" : "ChatGPT подписка"}
          </button>
        ))}
      </div>

      {s.provider === "openrouter" ? (
        <div className="mt-3 space-y-3">
          <label className="block text-sm">
            <span className="text-dim">Модель OpenRouter (id с openrouter.ai/models)</span>
            <input
              value={s.openrouter.model}
              onChange={(e) => setS({ ...s, openrouter: { ...s.openrouter, model: e.target.value } })}
              placeholder="например qwen/qwen3.8-27b:free"
              className={`${input} mt-1 w-full font-mono`}
            />
          </label>
          <label className="flex cursor-pointer items-center gap-3 text-sm">
            <button
              role="switch"
              aria-checked={s.openrouter.free}
              onClick={() => setS({ ...s, openrouter: { ...s.openrouter, free: !s.openrouter.free } })}
              className={`relative h-5 w-9 rounded-full transition-colors ${s.openrouter.free ? "bg-ok" : "bg-line"}`}
            >
              <span className={`absolute top-0.5 size-4 rounded-full bg-ink transition-all ${s.openrouter.free ? "left-[18px]" : "left-0.5"}`} />
            </button>
            <span>Бесплатная модель (free)</span>
            <span className="text-xs text-faint">статистика free и платных ведётся отдельно</span>
          </label>
          {freeMismatch && (
            <p className="text-xs text-warn">
              {orModel.endsWith(":free") ? "Id заканчивается на :free, но переключатель выключен." : "Переключатель free включён, а у id нет суффикса :free."}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3 space-y-3">
          {!data.status.chatgpt.loggedIn && <p className="text-xs text-warn">Сначала войдите в ChatGPT в блоке «Подключения».</p>}
          <div className="flex items-end gap-2">
            <label className="block flex-1 text-sm">
              <span className="text-dim">Модель</span>
              <select
                value={s.chatgpt.model}
                onChange={(e) => {
                  const m = models?.models.find((x) => x.id === e.target.value);
                  const effort = m && m.efforts.length && !m.efforts.includes(s.chatgpt.effort) ? m.defaultEffort ?? m.efforts[0] : s.chatgpt.effort;
                  setS({ ...s, chatgpt: { model: e.target.value, effort } });
                }}
                className={`${input} mt-1 w-full`}
              >
                <option value="">Авто (первая из списка)</option>
                {models?.models.map((m) => <option key={m.id} value={m.id}>{m.title}</option>)}
              </select>
            </label>
            <label className="block text-sm">
              <span className="text-dim">Рассуждение</span>
              <select value={s.chatgpt.effort} onChange={(e) => setS({ ...s, chatgpt: { ...s.chatgpt, effort: e.target.value } })} className={`${input} mt-1`}>
                {efforts.map((e) => <option key={e}>{e}</option>)}
              </select>
            </label>
            <button title="Обновить список моделей" onClick={() => loadModels(true)} className={`${btn} border border-line text-dim`}>
              <RefreshCw size={14} />
            </button>
          </div>
          {gptModel?.description && <p className="text-xs text-faint">{gptModel.description}</p>}
          {models && !models.live && (
            <p className="text-xs text-faint">Список аккаунта недоступен{models.error ? ` (${models.error})` : ""}, показан запасной.</p>
          )}
        </div>
      )}

      <div className="mt-4 flex items-center gap-2">
        <button disabled={!dirty} onClick={() => save().then(() => setNote({ ok: true, text: "Сохранено" }))} className={`${btn} bg-accent`}>Сохранить</button>
        <button disabled={busy} onClick={test} className={`${btn} border border-line`}>{busy ? "Проверяю…" : "Проверить"}</button>
      </div>
      {note && <p className={`mt-2 break-words text-xs ${note.ok ? "text-ok" : "text-bad"}`}>{note.text}</p>}
    </section>
  );
}

function AnalysisCard({ data, api, onSaved, onError }: {
  data: LlmSettingsResponse; api: Api; onSaved: () => void; onError: (e: string | null) => void;
}) {
  const [jev, setJev] = useState(data.analysis.jev);
  useEffect(() => setJev(data.analysis.jev), [data.analysis.jev]);
  const save = (next = jev) => api.patch("/api/llm/analysis", { jev: next }).then(() => (onError(null), onSaved()), (e: Error) => onError(e.message));
  const dirty = JSON.stringify(jev) !== JSON.stringify(data.analysis.jev);
  return (
    <section className={card}>
      <div className="flex items-center gap-2">
        <Sparkles size={18} />
        <h3 className="font-semibold">Jev (модель принятия решений)</h3>
        <label className="ml-auto flex items-center gap-2 text-sm">
          <input type="checkbox" checked={jev.enabled} onChange={(e) => void save({ ...jev, enabled: e.target.checked })} />
          Включён
        </label>
      </div>
      <p className="mt-2 text-sm text-dim">
        Необязательный второй движок для «Сравнения и анализа». По умолчанию анализ делает модель основного чата. Jev отвечает
        вероятностями без текста, дёшево и быстро разбирает большие пулы пар; объяснения пишет модель чата. Работает через ключ
        OpenRouter, расходы идут в корзину «Анализ».
      </p>
      <div className="mt-3 flex flex-wrap items-end gap-3">
        <label className="text-xs text-faint">
          Модель
          <input value={jev.model} onChange={(e) => setJev({ ...jev, model: e.target.value })} className={`${input} mt-1 block w-64`} />
        </label>
        <label className="text-xs text-faint" title="Ниже этой уверенности пару решает модель чата (или она помечается «неуверенно»)">
          Порог уверенности: {Math.round(jev.threshold * 100)}%
          <input type="range" min={0} max={1} step={0.05} value={jev.threshold}
            onChange={(e) => setJev({ ...jev, threshold: Number(e.target.value) })} className="mt-2 block w-56" />
        </label>
        <button onClick={() => void save()} disabled={!dirty} className={`${btn} bg-accent`}><Check size={15} /> Сохранить</button>
      </div>
    </section>
  );
}
