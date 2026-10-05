// Chat state per channel, outside React: switching sections unmounts the panel, but conversations,
// streaming answers and pending attachments stay here. Conversations are saved on the server
// (/api/chats), so they survive reloads and app updates; "new chat" keeps the previous ones.
// The workbench chat ("work") shows several conversations as tabs, one per report; each streams on its own,
// so switching tabs never loses an answer.
import { useSyncExternalStore } from "react";
import type { ChatChannel, CostTier, Usage } from "@trellis/core";
import { composeMessage, onAttachments, takeAttachments, type ChatAttachment } from "./chat-inbox.ts";
import { streamChat } from "./llm-client.ts";

export interface ChatMsg {
  role: "user" | "assistant";
  content: string;
  /** What the model got for a user message with attachments; `content` is what the user typed. */
  sent?: string;
  attachments?: ChatAttachment[];
  usage?: Usage;
  tier?: CostTier;
  model?: string;
  error?: string;
  at?: string;
}
/** What a conversation is about: a finding, a requirement, a page, a case… One conversation per `key`. */
export interface ChatSubject { kind: string; key: string; title: string }
export interface ConversationMeta {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  count: number;
  subject?: ChatSubject;
  open?: boolean;
}
export interface ChatTab { id: string; title: string; busy: boolean; subject?: ChatSubject }

export interface ChatSnapshot {
  loaded: boolean;
  /** Saved conversations, newest first. */
  list: ConversationMeta[];
  /** The conversation on screen. */
  id: string;
  messages: ChatMsg[];
  busy: boolean;
  attached: ChatAttachment[];
  subject?: ChatSubject;
  /** Open tabs (workbench chat); other chats have just the current conversation. */
  tabs: ChatTab[];
  /** Load or save problem; the chat keeps working in memory. */
  storeError: string | null;
  /** Text put into the input by a button elsewhere (a test run prompt); `seq` changes each time it is set. */
  draft?: { text: string; seq: number };
}

interface Conv {
  id: string;
  title: string;
  subject?: ChatSubject;
  messages: ChatMsg[];
  attached: ChatAttachment[];
  busy: boolean;
  open: boolean;
  abort?: AbortController;
  /** Saves of one conversation run in order, so an older one never overwrites a newer one. */
  saving?: Promise<void>;
  draft?: { text: string; seq: number };
}

export interface OpenSubjectOptions {
  /** Put into the input, ready to send or edit. */
  draft?: string;
  /** A new conversation even when one about the same subject exists, unless that one has nothing sent yet. */
  fresh?: boolean;
}

let draftSeq = 0;
const sumUsage = (a: Usage | undefined, b: Usage): Usage => a
  ? { ...b, inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens, costUsd: a.costUsd + b.costUsd }
  : b;

const NEW_TITLE = "Новый чат";
const newId = () => crypto.randomUUID();
const KEY = (c: ChatChannel) => `trellis.chat.${c}`;
function remember(c: ChatChannel, id: string) {
  try { localStorage.setItem(KEY(c), id); } catch { /* storage blocked: only the choice is lost */ }
}
function recall(c: ChatChannel) {
  try { return localStorage.getItem(KEY(c)); } catch { return null; }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `${res.status} ${res.statusText}`);
  return j as T;
}

const blank = (c: Conv) => !c.messages.length && !c.subject && !c.attached.length;

class ChatController {
  private snap: ChatSnapshot;
  private listeners = new Set<() => void>();
  private loading: Promise<void> | null = null;
  private convs = new Map<string, Conv>();
  private tabIds: string[] = [];
  private active: string;
  private list: ConversationMeta[] = [];
  private loaded = false;
  private storeError: string | null = null;
  private readonly tabbed: boolean;

  constructor(private readonly channel: ChatChannel) {
    this.tabbed = channel === "work";
    this.active = this.blankConv().id;
    this.snap = this.build();
    // Attachments are taken here, not inside a React updater, so none get lost or doubled.
    const pull = (c: ChatChannel) => {
      if (c !== channel) return;
      const got = takeAttachments(channel);
      if (!got.length) return;
      const conv = this.cur();
      conv.attached = [...conv.attached, ...got].slice(-8);
      this.emit();
    };
    onAttachments(pull);
    pull(channel);
  }

  get = () => this.snap;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private build(): ChatSnapshot {
    const c = this.cur();
    const tabs = (this.tabbed ? this.tabIds : [this.active]).flatMap((id) => {
      const t = this.convs.get(id);
      return t ? [{ id, title: t.title, busy: t.busy, subject: t.subject }] : [];
    });
    return {
      loaded: this.loaded, list: this.list, id: c.id, messages: c.messages, busy: c.busy, attached: c.attached,
      subject: c.subject, tabs, storeError: this.storeError, draft: c.draft,
    };
  }
  private emit() {
    this.snap = this.build();
    for (const l of this.listeners) l();
  }
  private cur(): Conv {
    return this.convs.get(this.active)!;
  }
  private blankConv(): Conv {
    const c: Conv = { id: newId(), title: NEW_TITLE, messages: [], attached: [], busy: false, open: true };
    this.convs.set(c.id, c);
    if (this.tabbed) this.tabIds.push(c.id);
    return c;
  }
  private focus(id: string) {
    this.active = id;
    remember(this.channel, id);
    this.emit();
  }

  load() {
    this.loading ??= (async () => {
      try {
        const { items } = await call<{ items: ConversationMeta[] }>("GET", `/api/chats/${this.channel}`);
        this.list = items;
        const want = recall(this.channel);
        if (this.tabbed) {
          const open = items.filter((c) => c.open).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          for (const m of open) await this.fetch(m.id).catch(() => undefined);
          // Tabs opened before the history arrived (a report sent to chat right away) stay after the saved ones.
          const saved = open.map((m) => m.id).filter((id) => this.convs.has(id));
          this.tabIds = [...saved, ...this.tabIds.filter((id) => !saved.includes(id) && !blank(this.convs.get(id)!))];
          const pick = this.tabIds.includes(this.active) && !blank(this.cur()) ? this.active
            : want && this.tabIds.includes(want) ? want : this.tabIds.at(-1);
          if (pick) this.active = pick;
          else this.active = this.blankConv().id;
        } else {
          const pick = items.find((c) => c.id === want) ?? items[0];
          if (pick && blank(this.cur())) {
            await this.fetch(pick.id);
            this.active = pick.id;
          }
        }
      } catch (e) {
        this.storeError = `История не загрузилась: ${(e as Error).message}`;
      } finally {
        this.loaded = true;
        this.emit();
      }
    })();
    return this.loading;
  }

  private async fetch(id: string): Promise<Conv> {
    const have = this.convs.get(id);
    if (have) return have;
    const c = await call<{ id: string; title: string; messages: ChatMsg[]; subject?: ChatSubject; open?: boolean; pending?: ChatAttachment[] }>(
      "GET", `/api/chats/${this.channel}/${id}`);
    const conv: Conv = {
      id: c.id, title: c.title, subject: c.subject, messages: c.messages, attached: c.pending ?? [], busy: false, open: c.open ?? false,
    };
    this.convs.set(id, conv);
    return conv;
  }

  /** Shows a saved conversation; in the workbench chat it becomes a tab again. */
  async open(id: string) {
    try {
      const conv = await this.fetch(id);
      if (this.tabbed && !this.tabIds.includes(id)) {
        conv.open = true;
        this.tabIds.push(id);
        void this.persist(id);
      }
      this.storeError = null;
      this.focus(id);
    } catch (e) {
      this.storeError = `Чат не открылся: ${(e as Error).message}`;
      this.emit();
    }
  }

  select(id: string) {
    if (this.convs.has(id)) this.focus(id);
  }

  private async persist(id: string) {
    const conv = this.convs.get(id);
    if (!conv || blank(conv)) return;
    const run = async () => {
      try {
        const meta = await call<ConversationMeta>("PUT", `/api/chats/${this.channel}/${id}`, {
          messages: conv.messages,
          ...(conv.subject ? { title: conv.subject.title, subject: conv.subject } : {}),
          ...(this.tabbed ? { open: conv.open } : {}),
          pending: conv.attached,
        });
        conv.title = meta.title;
        this.list = [meta, ...this.list.filter((c) => c.id !== id)];
        this.storeError = null;
        if (id === this.active) remember(this.channel, id);
      } catch (e) {
        this.storeError = `Чат не сохранился: ${(e as Error).message}`;
      }
      this.emit();
    };
    conv.saving = (conv.saving ?? Promise.resolve()).then(run);
    return conv.saving;
  }

  /** Starts an empty conversation; the current one stays in the list (and in its tab). */
  newChat() {
    const empty = this.tabbed ? this.tabIds.map((id) => this.convs.get(id)!).find(blank) : blank(this.cur()) ? this.cur() : undefined;
    this.focus((empty ?? this.blankConv()).id);
  }

  /** Closes a tab of the workbench chat; the conversation stays in the history. An answer being written still gets saved. */
  closeTab(id: string) {
    const conv = this.convs.get(id);
    if (!this.tabbed || !conv) return;
    const at = this.tabIds.indexOf(id);
    this.tabIds = this.tabIds.filter((t) => t !== id);
    conv.open = false;
    if (blank(conv)) this.convs.delete(id);
    else void this.persist(id);
    if (this.active === id) {
      const next = this.tabIds[Math.min(at, this.tabIds.length - 1)];
      this.active = next ?? this.blankConv().id;
    }
    this.focus(this.active);
  }

  /** Deletes the current conversation. */
  async clear() {
    await this.remove(this.active);
  }

  async remove(id: string) {
    const conv = this.convs.get(id);
    if (conv?.busy) return;
    this.list = this.list.filter((c) => c.id !== id);
    this.convs.delete(id);
    if (this.tabbed) {
      const at = this.tabIds.indexOf(id);
      this.tabIds = this.tabIds.filter((t) => t !== id);
      if (this.active === id) this.active = this.tabIds[Math.min(Math.max(at, 0), this.tabIds.length - 1)] ?? this.blankConv().id;
    } else if (this.active === id) this.active = this.blankConv().id;
    this.emit();
    try {
      await call("DELETE", `/api/chats/${this.channel}/${id}`);
    } catch (e) {
      this.storeError = `Чат не удалился: ${(e as Error).message}`;
      this.emit();
    }
  }

  removeAttachment(id: string) {
    const conv = this.cur();
    conv.attached = conv.attached.filter((a) => a.id !== id);
    this.emit();
    void this.persist(conv.id);
  }

  stop() {
    this.cur().abort?.abort();
  }

  /**
   * Opens the conversation about `subject` (a new tab the first time) with `attachment` ready to send.
   * A conversation that already discussed the same report text just comes to the front; a changed report
   * (an edited draft, a re-run analysis) is attached again.
   */
  async openSubject(subject: ChatSubject, attachment: Omit<ChatAttachment, "id">, opts: OpenSubjectOptions = {}) {
    await this.load();
    const a = { ...attachment, id: newId() };
    const draft = opts.draft ? { text: opts.draft, seq: ++draftSeq } : undefined;
    const known = opts.fresh
      ? [...this.convs.values()].find((c) => c.subject?.key === subject.key && !c.messages.length && this.tabIds.includes(c.id))?.id
      : [...this.convs.values()].find((c) => c.subject?.key === subject.key)?.id ?? this.list.find((c) => c.subject?.key === subject.key)?.id;
    if (known) {
      await this.open(known);
      const conv = this.convs.get(known);
      if (conv && draft) {
        conv.draft = draft;
        this.emit();
      }
      const seen = conv && [...conv.attached, ...conv.messages.flatMap((m) => m.attachments ?? [])].some((x) => x.text === a.text && x.quote === a.quote);
      if (conv && !seen) {
        conv.attached = [...conv.attached, a].slice(-8);
        this.emit();
        void this.persist(known);
      }
      return;
    }
    // An empty "new chat" tab is replaced by the report.
    if (this.tabbed) {
      for (const id of this.tabIds.filter((t) => blank(this.convs.get(t)!))) this.convs.delete(id);
      this.tabIds = this.tabIds.filter((t) => this.convs.has(t));
    }
    const conv: Conv = { id: newId(), title: subject.title, subject, messages: [], attached: [a], busy: false, open: true, draft };
    this.convs.set(conv.id, conv);
    if (this.tabbed) this.tabIds.push(conv.id);
    this.focus(conv.id);
    await this.persist(conv.id);
  }

  async send(input: string) {
    const conv = this.cur();
    const { attached, busy } = conv;
    const text = input.trim() || (attached.length ? "Разбери это: что не так и что поправить?" : "");
    if (!text || busy) return;
    await this.load();
    const at = new Date().toISOString();
    const user: ChatMsg = attached.length
      ? { role: "user", content: text, sent: composeMessage(attached, text), attachments: attached, at }
      : { role: "user", content: text, at };
    const history = [...conv.messages.filter((m) => !m.error), user];
    conv.messages = [...history, { role: "assistant", content: "" }];
    conv.attached = [];
    conv.busy = true;
    this.emit();
    void this.persist(conv.id);
    const ac = new AbortController();
    conv.abort = ac;
    const patch = (fn: (m: ChatMsg) => ChatMsg) => {
      const all = conv.messages;
      conv.messages = [...all.slice(0, -1), fn(all[all.length - 1])];
      this.emit();
    };
    try {
      const payload = history.map(({ role, content, sent }) => ({ role, content: sent ?? content }));
      for await (const ev of streamChat(this.channel, payload, conv.id, ac.signal)) {
        if (ev.type === "meta") patch((m) => ({ ...m, model: ev.model, tier: ev.tier }));
        else if (ev.type === "text") patch((m) => ({ ...m, content: m.content + ev.delta }));
        // An answer with browser steps calls the model several times: the usage adds up.
        else if (ev.type === "usage") patch((m) => ({ ...m, usage: sumUsage(m.usage, ev.usage), tier: ev.tier }));
        else if (ev.type === "error") patch((m) => ({ ...m, error: ev.message }));
      }
    } catch (e) {
      patch((m) => ({ ...m, error: ac.signal.aborted ? m.error ?? (m.content ? undefined : "Остановлено") : (e as Error).message }));
    } finally {
      patch((m) => ({ ...m, at: new Date().toISOString() }));
      conv.abort = undefined;
      conv.busy = false;
      this.emit();
      // A conversation deleted while answering stays deleted.
      if (this.convs.has(conv.id)) await this.persist(conv.id);
    }
  }
}

const controllers: Partial<Record<ChatChannel, ChatController>> = {};
export function chatController(channel: ChatChannel) {
  return (controllers[channel] ??= new ChatController(channel));
}

export function useChat(channel: ChatChannel) {
  const c = chatController(channel);
  const snap = useSyncExternalStore(c.subscribe, c.get);
  return { ...snap, chat: c };
}

export const WORKBENCH_VIEW_KEY = "trellis.workbench.view";
export const WORKBENCH_VIEW_EVENT = "trellis:workbench-view";

/**
 * Sends a report to the big chat of «Рабочее место»: its own tab (the same tab next time), the report attached,
 * and the app switches to that chat.
 */
export function openInWorkChat(subject: ChatSubject, attachment: Omit<ChatAttachment, "id">, opts?: OpenSubjectOptions) {
  void chatController("work").openSubject(subject, attachment, opts);
  try { localStorage.setItem(WORKBENCH_VIEW_KEY, "chat"); } catch { /* the workbench opens on its last view */ }
  dispatchEvent(new CustomEvent(WORKBENCH_VIEW_EVENT, { detail: "chat" }));
  location.hash = "/workbench";
}
