import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Eraser, History, icons, Loader2, MessageSquarePlus, Paperclip, Plus, SendHorizontal, Square, Trash2, X } from "lucide-react";
import { channelBucket, type ChatActionDecl, type ChatChannel, type ModuleManifest } from "@trellis/core";
import { ChangeCard, splitChanges } from "./ChangeCard.tsx";
import { useChat, type ChatMsg as Msg } from "./chat-store.ts";
import { splitToolBlocks, ToolCallLine, ToolResultLine } from "./ToolBlocks.tsx";
import { modelLabel, type LlmSettingsResponse } from "./llm-client.ts";

export interface ChatPanelProps {
  channel: ChatChannel;
  title: string;
  icon: ReactNode;
  intro: string;
  placeholder: string;
  compact?: boolean;
  /** Fill the parent's height instead of a fixed one (the parent sets it). */
  fill?: boolean;
  /** Conversations as tabs (workbench chat). */
  tabs?: boolean;
  /** Wide, roomy messages for reading long analysis. */
  wide?: boolean;
  api: { get<T>(path: string): Promise<T>; post<T>(path: string, body?: unknown): Promise<T> };
  navigate(moduleId: string): void;
}

/** Fired on window after a chat action succeeded, so the module's own view can refresh. */
export const CHAT_ACTION_EVENT = "trellis:chat-action";

/** Message actions modules add to this chat in their manifest (`chat[].actions`). */
function useChatActions(api: ChatPanelProps["api"], channel: ChatChannel) {
  const [actions, setActions] = useState<(ChatActionDecl & { module: string })[]>([]);
  useEffect(() => {
    api.get<{ modules: { manifest: ModuleManifest; enabled: boolean }[] }>("/api/modules").then(
      (r) => setActions(r.modules.filter((m) => m.enabled).flatMap((m) => (m.manifest.chat ?? [])
        .filter((c) => c.channel === channel).flatMap((c) => (c.actions ?? []).map((a) => ({ ...a, module: m.manifest.title }))))),
      () => setActions([]),
    );
  }, [api, channel]);
  return actions;
}

function ActionIcon({ name }: { name?: string }) {
  const Comp = (name && icons[name as keyof typeof icons]) || Plus;
  return <Comp size={12} />;
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

/**
 * Shared chat: the side chat ("main"), the workbench chat with a tab per report ("work") and the dev chat ("dev").
 * State lives in chat-store, saved on the server.
 */
export function ChatPanel({ channel, title, icon, intro, placeholder, compact, fill, tabs: tabbed, wide, api, navigate }: ChatPanelProps) {
  const bucket = channelBucket(channel);
  const [cfg, setCfg] = useState<LlmSettingsResponse | null>(null);
  const { messages, busy, attached, list, id, loaded, storeError, tabs, subject, draft, chat } = useChat(channel);
  // Drafts are kept per conversation, so switching tabs does not mix questions.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const input = drafts[id] ?? "";
  const setInput = (v: string) => setDrafts((d) => ({ ...d, [id]: v }));
  const [showList, setShowList] = useState(false);
  const [notice, setNotice] = useState<{ text: string; bad?: boolean } | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  const actions = useChatActions(api, channel);
  // A prompt put in by a button elsewhere (e.g. «Пройти тест») replaces what is typed in that conversation.
  useEffect(() => {
    if (draft) setDrafts((d) => ({ ...d, [id]: draft.text }));
  }, [draft?.seq]); // eslint-disable-line react-hooks/exhaustive-deps
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api.get<LlmSettingsResponse>("/api/llm/settings").then(setCfg, () => setCfg(null));
  }, [api]);
  useEffect(() => void chat.load(), [chat]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [messages]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(t);
  }, [notice]);

  /** Posts a message to a module route, e.g. saves it as an idea. The title can be edited first. */
  const runAction = async (a: ChatActionDecl, m: Msg, key: string) => {
    const first = m.content.split("\n").map((l) => l.replace(/^[#>*\-\s]+/, "").trim()).find(Boolean) ?? "";
    const name = prompt(`${a.label}: название`, first.slice(0, 120));
    if (name === null || !name.trim()) return;
    setRunning(key);
    try {
      const r = await api.post<{ id?: string; title?: string }>(a.post, { title: name.trim().slice(0, 200), summary: m.content.slice(0, 4000), source: "chat" });
      setNotice({ text: `${a.label}: сохранено${r?.id ? ` (${r.id})` : ""}` });
      dispatchEvent(new CustomEvent(CHAT_ACTION_EVENT, { detail: { post: a.post } }));
    } catch (e) {
      setNotice({ text: `${a.label}: ${(e as Error).message}`, bad: true });
    } finally {
      setRunning(null);
    }
  };

  const label = modelLabel(cfg?.settings[bucket]);
  const height = fill ? "h-full min-h-0" : compact ? "h-[560px]" : "h-[calc(100vh-120px)]";
  const kind: Record<string, string> = { finding: "Находка", requirement: "Требование", doc: "Документ", case: "Кейс", remark: "Замечание", draft: "Черновик", run: "Прогон" };
  const ready = !!label;
  const send = () => {
    if (busy || (!input.trim() && !attached.length)) return;
    void chat.send(input);
    setInput("");
  };
  const tool = "grid size-7 shrink-0 place-items-center rounded-md text-faint hover:bg-raised hover:text-ink disabled:opacity-40";

  return (
    <section className={`flex flex-col rounded-xl border border-line bg-panel ${height}`}>
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
        <button title={tabbed ? "Новая вкладка" : "Новый чат (текущий сохранится в истории)"}
          disabled={!tabbed && (busy || !messages.length)} onClick={() => chat.newChat()} className={tool}>
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

      {tabbed && tabs.length > 0 && (
        <nav className="flex gap-1 overflow-x-auto border-b border-line px-2 pt-2">
          {tabs.map((t) => (
            <div key={t.id} title={t.subject ? `${kind[t.subject.kind] ?? t.subject.kind}: ${t.subject.title}` : t.title}
              className={`group flex max-w-[240px] shrink-0 items-center gap-1 rounded-t-md border border-b-0 px-2 py-1.5 text-xs ${
                t.id === id ? "border-line bg-raised text-ink" : "border-transparent text-dim hover:bg-raised/60 hover:text-ink"}`}>
              <button onClick={() => chat.select(t.id)} className="flex min-w-0 items-center gap-1.5">
                {t.busy && <Loader2 size={11} className="shrink-0 animate-spin" />}
                {t.subject && <span className="shrink-0 rounded bg-accent-soft px-1 text-[10px] text-accent">{kind[t.subject.kind] ?? t.subject.kind}</span>}
                <span className="truncate">{t.title}</span>
              </button>
              <button title="Закрыть вкладку (диалог останется в истории)" onClick={() => chat.closeTab(t.id)}
                className="shrink-0 text-faint opacity-60 hover:text-ink group-hover:opacity-100">
                <X size={12} />
              </button>
            </div>
          ))}
        </nav>
      )}

      {showList && (
        <div className="max-h-56 overflow-auto border-b border-line p-2 text-sm">
          {!list.length && <div className="px-2 py-1 text-xs text-faint">{loaded ? "Сохранённых чатов пока нет." : "Загрузка…"}</div>}
          {list.map((c) => (
            <div key={c.id} className={`group flex items-center gap-2 rounded-md px-2 py-1 ${c.id === id ? "bg-accent-soft" : "hover:bg-raised"}`}>
              <button onClick={() => (void chat.open(c.id), setShowList(false))} className="min-w-0 flex-1 text-left">
                <div className="truncate">{c.subject && <span className="text-faint">{kind[c.subject.kind] ?? c.subject.kind} · </span>}{c.title}</div>
                <div className="text-[11px] text-faint">
                  {new Date(c.updatedAt).toLocaleString("ru")} · {c.count} сообщ.{tabbed && c.open ? " · открыт" : ""}
                </div>
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

      <div ref={scroller} className={`flex-1 overflow-auto p-3 ${wide ? "text-[15px] leading-relaxed" : "text-sm"}`}>
       <div className={`space-y-3 ${wide ? "mx-auto max-w-[920px]" : ""}`}>
        {storeError && <div className="rounded-lg border border-bad/40 p-2 text-xs text-bad">{storeError}</div>}
        {messages.length === 0 && (
          <div className="rounded-lg bg-raised p-3 text-dim">
            {subject?.kind === "run"
              ? <>{subject.title}. Кейс приложен, задание в поле ввода: проверьте адрес и данные, затем отправьте. Агент откроет браузер и будет проходить шаги, результаты появятся здесь.</>
              : subject ? <>Вкладка по отчёту «{subject.title}». Контекст приложен ниже: задайте вопрос или отправьте как есть.</> : intro}
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`group/msg ${m.role === "user" ? "flex flex-col items-end" : ""}`}>
            <div className={`${wide ? "max-w-[96%]" : "max-w-[92%]"} rounded-lg px-3 py-2 ${m.role === "user" ? "bg-accent-soft" : "bg-raised"}`}>
              {m.attachments?.map((a) => (
                <div key={a.id} title={a.text} className="mb-1 flex items-center gap-1 text-[11px] text-dim">
                  <Paperclip size={11} className="shrink-0" />
                  <span className="truncate">{a.title}{a.quote ? ` · «${a.quote.slice(0, 60)}${a.quote.length > 60 ? "…" : ""}»` : ""}</span>
                </div>
              ))}
              <div className="whitespace-pre-wrap break-words">
                {m.content
                  ? m.role === "assistant"
                    ? splitChanges(m.content).map((seg, k) => (seg.kind === "change" ? <ChangeCard key={k} raw={seg.raw} /> : (
                      splitToolBlocks(seg.text).map((t, j) => t.kind === "call" ? <ToolCallLine key={`${k}.${j}`} tool={t.tool} raw={t.raw} />
                        : t.kind === "result" ? <ToolResultLine key={`${k}.${j}`} raw={t.raw} /> : <span key={`${k}.${j}`}>{t.text}</span>)
                    )))
                    : m.content
                  : busy && i === messages.length - 1 && !m.error ? <span className="text-faint">думает…</span> : null}
              </div>
              {m.error && <div className="mt-1 text-xs text-bad">{m.error}</div>}
              {usageText(m) && <div className="mt-1 text-[11px] text-faint">{usageText(m)}</div>}
            </div>
            {actions.length > 0 && m.content && !(busy && i === messages.length - 1) && (
              <div className="mt-1 flex gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100 focus-within:opacity-100">
                {actions.map((a) => (
                  <button key={`${a.module}:${a.id}`} title={`${a.label} (${a.module})`} disabled={running === `${i}:${a.id}`}
                    onClick={() => void runAction(a, m, `${i}:${a.id}`)}
                    className="flex items-center gap-1 rounded-md border border-line px-1.5 py-0.5 text-[11px] text-dim hover:text-ink disabled:opacity-50">
                    <ActionIcon name={a.icon} /> {a.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
       </div>
      </div>

      <footer className={`border-t border-line p-3 ${wide ? "[&>*]:mx-auto [&>*]:max-w-[920px]" : ""}`}>
        {notice && <div className={`mb-2 text-xs ${notice.bad ? "text-bad" : "text-ok"}`}>{notice.text}</div>}
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
            rows={Math.min(12, Math.max(wide ? 3 : 2, input.split("\n").length))}
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
