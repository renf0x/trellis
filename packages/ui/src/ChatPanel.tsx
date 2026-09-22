import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Paperclip, SendHorizontal, Square, Trash2, X } from "lucide-react";
import type { ChatBucket, CostTier, Usage } from "@trellis/core";
import { composeMessage, onAttachments, takeAttachments, type ChatAttachment } from "./chat-inbox.ts";
import { modelLabel, streamChat, type LlmSettingsResponse } from "./llm-client.ts";

interface Msg {
  role: "user" | "assistant";
  content: string;
  /** What the model got for a user message with attachments; `content` is what the user typed. */
  sent?: string;
  attachments?: ChatAttachment[];
  usage?: Usage;
  tier?: CostTier;
  model?: string;
  error?: string;
}

export interface ChatPanelProps {
  bucket: ChatBucket;
  title: string;
  icon: ReactNode;
  intro: string;
  placeholder: string;
  compact?: boolean;
  api: { get<T>(path: string): Promise<T> };
  navigate(moduleId: string): void;
}

const newSession = () => crypto.randomUUID();

function usageText(m: Msg) {
  if (!m.usage) return null;
  const tokens = `${m.usage.inputTokens.toLocaleString("ru")} → ${m.usage.outputTokens.toLocaleString("ru")} ток.`;
  const cost = m.tier === "subscription" ? "по подписке" : m.tier === "free" ? "free" : `$${m.usage.costUsd.toFixed(5)}`;
  // Prefer the model the provider says it ran; flag it when that differs from what was requested.
  const served = m.usage.model;
  const model = !served ? `${m.model ?? ""} (не подтверждено)` : served === m.model?.replace(/:free$/, "") || served === m.model ? `${served} ✓` : `${served} (запрошена ${m.model})`;
  return `${model} · ${tokens} · ${cost}`;
}

/** Shared chat for the QA agent (bucket "main") and the dev chat (bucket "dev"). History lives in the tab for now. */
export function ChatPanel({ bucket, title, icon, intro, placeholder, compact, api, navigate }: ChatPanelProps) {
  const [cfg, setCfg] = useState<LlmSettingsResponse | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attached, setAttached] = useState<ChatAttachment[]>([]);
  const abort = useRef<AbortController | null>(null);
  const session = useRef(newSession());
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<LlmSettingsResponse>("/api/llm/settings").then(setCfg, () => setCfg(null));
  }, [api]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);
  useEffect(() => () => abort.current?.abort(), []);
  useEffect(() => {
    const pull = (b: ChatBucket) => b === bucket && setAttached((cur) => [...cur, ...takeAttachments(bucket)].slice(-8));
    pull(bucket);
    return onAttachments(pull);
  }, [bucket]);

  const label = modelLabel(cfg?.settings[bucket]);
  const ready = !!label;

  async function send() {
    const text = input.trim() || (attached.length ? "Разбери это: что не так и что поправить?" : "");
    if (!text || busy) return;
    const user: Msg = attached.length
      ? { role: "user", content: text, sent: composeMessage(attached, text), attachments: attached }
      : { role: "user", content: text };
    const history = [...messages.filter((m) => !m.error), user];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setAttached([]);
    setBusy(true);
    const ac = new AbortController();
    abort.current = ac;
    const patch = (fn: (m: Msg) => Msg) => setMessages((all) => [...all.slice(0, -1), fn(all[all.length - 1])]);
    try {
      const payload = history.map(({ role, content, sent }) => ({ role, content: sent ?? content }));
      for await (const ev of streamChat(bucket, payload, session.current, ac.signal)) {
        if (ev.type === "meta") patch((m) => ({ ...m, model: ev.model, tier: ev.tier }));
        else if (ev.type === "text") patch((m) => ({ ...m, content: m.content + ev.delta }));
        else if (ev.type === "usage") patch((m) => ({ ...m, usage: ev.usage, tier: ev.tier }));
        else if (ev.type === "error") patch((m) => ({ ...m, error: ev.message }));
      }
    } catch (e) {
      if (!ac.signal.aborted) patch((m) => ({ ...m, error: (e as Error).message }));
    } finally {
      setBusy(false);
      abort.current = null;
    }
  }

  return (
    <section className={`flex flex-col rounded-xl border border-line bg-panel ${compact ? "h-[560px]" : "h-[calc(100vh-120px)]"}`}>
      <header className="flex items-center gap-2 border-b border-line p-3">
        {icon}
        <h2 className="whitespace-nowrap font-semibold">{title}</h2>
        <button
          onClick={() => navigate("settings")}
          title="Сменить модель в настройках"
          className="ml-auto flex min-w-0 items-center gap-1 rounded-md border border-line px-2 py-1 text-xs text-dim hover:text-ink"
        >
          <span className={`size-2 shrink-0 rounded-full ${ready ? "bg-ok" : "bg-faint"}`} />
          <span className="truncate">{label ?? "Нет модели"}</span>
          <ChevronRight size={12} className="shrink-0" />
        </button>
        {messages.length > 0 && (
          <button
            title="Новый диалог"
            disabled={busy}
            onClick={() => (setMessages([]), (session.current = newSession()))}
            className="text-faint hover:text-ink"
          >
            <Trash2 size={15} />
          </button>
        )}
      </header>

      <div ref={scroller} className="flex-1 space-y-3 overflow-auto p-3 text-sm">
        {messages.length === 0 && <div className="rounded-lg bg-raised p-3 text-dim">{intro}</div>}
        {messages.map((m, i) => (
          <div key={i} className={m.role === "user" ? "flex justify-end" : ""}>
            <div className={`max-w-[92%] rounded-lg px-3 py-2 ${m.role === "user" ? "bg-accent-soft" : "bg-raised"}`}>
              {m.attachments?.map((a) => (
                <div key={a.id} title={a.text} className="mb-1 flex items-center gap-1 text-[11px] text-dim">
                  <Paperclip size={11} className="shrink-0" />
                  <span className="truncate">{a.title}{a.quote ? ` · «${a.quote.slice(0, 60)}${a.quote.length > 60 ? "…" : ""}»` : ""}</span>
                </div>
              ))}
              <div className="whitespace-pre-wrap break-words">
                {m.content || (busy && i === messages.length - 1 && !m.error ? <span className="text-faint">думает…</span> : null)}
              </div>
              {m.error && <div className="mt-1 text-xs text-bad">{m.error}</div>}
              {usageText(m) && <div className="mt-1 text-[11px] text-faint">{usageText(m)}</div>}
            </div>
          </div>
        ))}
      </div>

      <footer className="border-t border-line p-3">
        {attached.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {attached.map((a) => (
              <span key={a.id} title={a.quote ?? a.text.slice(0, 400)}
                className="flex max-w-full items-center gap-1 rounded-md border border-line bg-raised px-2 py-1 text-xs text-dim">
                <Paperclip size={12} className="shrink-0" />
                <span className="truncate">{a.title}{a.quote ? ` · «${a.quote.slice(0, 40)}…»` : ""}</span>
                <button onClick={() => setAttached((cur) => cur.filter((x) => x.id !== a.id))} className="text-faint hover:text-ink">
                  <X size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2 rounded-lg border border-line bg-raised p-2">
          <textarea
            rows={2}
            value={input}
            disabled={!ready}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={ready ? placeholder : "Выберите модель в «Настройках»"}
            className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-faint"
          />
          {busy ? (
            <button onClick={() => abort.current?.abort()} title="Остановить" className="grid size-8 place-items-center rounded-md bg-bad/80">
              <Square size={14} />
            </button>
          ) : (
            <button
              onClick={() => void send()}
              disabled={!ready || (!input.trim() && !attached.length)}
              title="Отправить (Enter)"
              className="grid size-8 place-items-center rounded-md bg-accent disabled:opacity-40"
            >
              <SendHorizontal size={16} />
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}
