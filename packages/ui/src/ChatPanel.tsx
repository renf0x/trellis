import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Eraser, History, MessageSquarePlus, Paperclip, SendHorizontal, Square, Trash2, X } from "lucide-react";
import type { ChatBucket } from "@trellis/core";
import { ChangeCard, splitChanges } from "./ChangeCard.tsx";
import { useChat, type ChatMsg as Msg } from "./chat-store.ts";
import { modelLabel, type LlmSettingsResponse } from "./llm-client.ts";

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

function usageText(m: Msg) {
  if (!m.usage) return null;
  const tokens = `${m.usage.inputTokens.toLocaleString("ru")} → ${m.usage.outputTokens.toLocaleString("ru")} ток.`;
  const cost = m.tier === "subscription" ? "по подписке" : m.tier === "free" ? "free" : `$${m.usage.costUsd.toFixed(5)}`;
  // Prefer the model the provider says it ran; flag it when that differs from what was requested.
  const served = m.usage.model;
  const model = !served ? `${m.model ?? ""} (не подтверждено)` : served === m.model?.replace(/:free$/, "") || served === m.model ? `${served} ✓` : `${served} (запрошена ${m.model})`;
  return `${model} · ${tokens} · ${cost}`;
}

/** Shared chat for the QA agent (bucket "main") and the dev chat (bucket "dev"). State lives in chat-store, saved on the server. */
export function ChatPanel({ bucket, title, icon, intro, placeholder, compact, api, navigate }: ChatPanelProps) {
  const [cfg, setCfg] = useState<LlmSettingsResponse | null>(null);
  const { messages, busy, attached, list, id, loaded, storeError, chat } = useChat(bucket);
  const [input, setInput] = useState("");
  const [showList, setShowList] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<LlmSettingsResponse>("/api/llm/settings").then(setCfg, () => setCfg(null));
  }, [api]);
  useEffect(() => void chat.load(), [chat]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);

  const label = modelLabel(cfg?.settings[bucket]);
  const ready = !!label;
  const send = () => {
    if (busy || (!input.trim() && !attached.length)) return;
    void chat.send(input);
    setInput("");
  };
  const tool = "grid size-7 shrink-0 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink disabled:opacity-40";

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
        <button title="История чатов" onClick={() => setShowList(!showList)} className={`${tool} ${showList ? "bg-raised text-ink" : ""}`}>
          <History size={15} />
        </button>
        <button title="Новый чат (текущий сохранится в истории)" disabled={busy || !messages.length} onClick={() => chat.newChat()} className={tool}>
          <MessageSquarePlus size={15} />
        </button>
        <button
          title="Очистить чат (удалить этот диалог)"
          disabled={busy || !messages.length}
          onClick={() => confirm("Удалить этот диалог? Остальные чаты в истории останутся.") && void chat.clear()}
          className={tool}
        >
          <Eraser size={15} />
        </button>
      </header>

      {showList && (
        <div className="max-h-56 overflow-auto border-b border-line p-2 text-sm">
          {!list.length && <div className="px-2 py-1 text-xs text-faint">{loaded ? "Сохранённых чатов пока нет." : "Загрузка…"}</div>}
          {list.map((c) => (
            <div key={c.id} className={`group flex items-center gap-2 rounded-md px-2 py-1 ${c.id === id ? "bg-accent-soft" : "hover:bg-raised"}`}>
              <button disabled={busy} onClick={() => (void chat.open(c.id), setShowList(false))} className="min-w-0 flex-1 text-left">
                <div className="truncate">{c.title}</div>
                <div className="text-[11px] text-faint">{new Date(c.updatedAt).toLocaleString("ru")} · {c.count} сообщ.</div>
              </button>
              <button
                title="Удалить чат"
                disabled={busy && c.id === id}
                onClick={() => confirm(`Удалить чат «${c.title}»?`) && void chat.remove(c.id)}
                className="text-faint opacity-0 hover:text-bad group-hover:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div ref={scroller} className="flex-1 space-y-3 overflow-auto p-3 text-sm">
        {storeError && <div className="rounded-lg border border-bad/40 p-2 text-xs text-bad">{storeError}</div>}
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
                {m.content
                  ? m.role === "assistant"
                    ? splitChanges(m.content).map((seg, k) => (seg.kind === "change" ? <ChangeCard key={k} raw={seg.raw} /> : <span key={k}>{seg.text}</span>))
                    : m.content
                  : busy && i === messages.length - 1 && !m.error ? <span className="text-faint">думает…</span> : null}
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
                <button onClick={() => chat.removeAttachment(a.id)} className="text-faint hover:text-ink">
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
                send();
              }
            }}
            placeholder={ready ? placeholder : "Выберите модель в «Настройках»"}
            className="flex-1 resize-none bg-transparent text-sm outline-none placeholder:text-faint"
          />
          {busy ? (
            <button onClick={() => chat.stop()} title="Остановить" className="grid size-8 place-items-center rounded-md bg-bad/80">
              <Square size={14} />
            </button>
          ) : (
            <button
              onClick={send}
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
