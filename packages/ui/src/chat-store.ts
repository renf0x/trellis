// Chat state per bucket, outside React: switching sections unmounts the panel, but the conversation,
// a streaming answer and pending attachments stay here. Conversations are saved on the server
// (/api/chats), so they survive reloads and app updates; "new chat" keeps the previous ones.
import { useSyncExternalStore } from "react";
import type { ChatBucket, CostTier, Usage } from "@trellis/core";
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
export interface ConversationMeta { id: string; title: string; createdAt: string; updatedAt: string; count: number }

export interface ChatSnapshot {
  loaded: boolean;
  /** Saved conversations, newest first. */
  list: ConversationMeta[];
  id: string;
  messages: ChatMsg[];
  busy: boolean;
  attached: ChatAttachment[];
  /** Load or save problem; the chat keeps working in memory. */
  storeError: string | null;
}

const newId = () => crypto.randomUUID();
const KEY = (b: ChatBucket) => `trellis.chat.${b}`;
function remember(b: ChatBucket, id: string) {
  try { localStorage.setItem(KEY(b), id); } catch { /* storage blocked: only the choice is lost */ }
}
function recall(b: ChatBucket) {
  try { return localStorage.getItem(KEY(b)); } catch { return null; }
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

class ChatController {
  private snap: ChatSnapshot;
  private listeners = new Set<() => void>();
  private abort: AbortController | null = null;
  private loading: Promise<void> | null = null;

  constructor(private readonly bucket: ChatBucket) {
    this.snap = { loaded: false, list: [], id: newId(), messages: [], busy: false, attached: [], storeError: null };
    // Attachments are taken here, not inside a React updater, so none get lost or doubled.
    const pull = (b: ChatBucket) => {
      if (b !== bucket) return;
      const got = takeAttachments(bucket);
      if (got.length) this.set({ attached: [...this.snap.attached, ...got].slice(-8) });
    };
    onAttachments(pull);
    pull(bucket);
  }

  get = () => this.snap;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  private set(patch: Partial<ChatSnapshot>) {
    this.snap = { ...this.snap, ...patch };
    for (const l of this.listeners) l();
  }

  load() {
    this.loading ??= (async () => {
      try {
        const { items } = await call<{ items: ConversationMeta[] }>("GET", `/api/chats/${this.bucket}`);
        const want = recall(this.bucket);
        const pick = items.find((c) => c.id === want) ?? items[0];
        this.set({ list: items });
        if (pick) await this.open(pick.id);
      } catch (e) {
        this.set({ storeError: `История не загрузилась: ${(e as Error).message}` });
      } finally {
        this.set({ loaded: true });
      }
    })();
    return this.loading;
  }

  async open(id: string) {
    if (this.snap.busy) return;
    const c = await call<{ id: string; messages: ChatMsg[] }>("GET", `/api/chats/${this.bucket}/${id}`);
    this.set({ id: c.id, messages: c.messages, storeError: null });
    remember(this.bucket, c.id);
  }

  private async persist() {
    const { id, messages } = this.snap;
    if (!messages.length) return;
    try {
      const meta = await call<ConversationMeta>("PUT", `/api/chats/${this.bucket}/${id}`, { messages });
      this.set({ list: [meta, ...this.snap.list.filter((c) => c.id !== id)], storeError: null });
      remember(this.bucket, id);
    } catch (e) {
      this.set({ storeError: `Чат не сохранился: ${(e as Error).message}` });
    }
  }

  /** Starts an empty conversation; the current one stays in the list. */
  newChat() {
    if (this.snap.busy) return;
    const id = newId();
    this.set({ id, messages: [] });
    remember(this.bucket, id);
  }

  /** Deletes the current conversation and starts an empty one. */
  async clear() {
    if (this.snap.busy) return;
    const old = this.snap.id;
    this.newChat();
    await this.remove(old);
  }

  async remove(id: string) {
    if (this.snap.busy && id === this.snap.id) return;
    this.set({ list: this.snap.list.filter((c) => c.id !== id) });
    if (id === this.snap.id) this.newChat();
    try {
      await call("DELETE", `/api/chats/${this.bucket}/${id}`);
    } catch (e) {
      this.set({ storeError: `Чат не удалился: ${(e as Error).message}` });
    }
  }

  removeAttachment(id: string) {
    this.set({ attached: this.snap.attached.filter((a) => a.id !== id) });
  }

  stop() {
    this.abort?.abort();
  }

  async send(input: string) {
    const { attached, busy } = this.snap;
    const text = input.trim() || (attached.length ? "Разбери это: что не так и что поправить?" : "");
    if (!text || busy) return;
    await this.load();
    const at = new Date().toISOString();
    const user: ChatMsg = attached.length
      ? { role: "user", content: text, sent: composeMessage(attached, text), attachments: attached, at }
      : { role: "user", content: text, at };
    const history = [...this.snap.messages.filter((m) => !m.error), user];
    const conv = this.snap.id;
    this.set({ messages: [...history, { role: "assistant", content: "" }], attached: [], busy: true });
    void this.persist();
    const ac = new AbortController();
    this.abort = ac;
    const patch = (fn: (m: ChatMsg) => ChatMsg) => {
      if (this.snap.id !== conv) return;
      const all = this.snap.messages;
      this.set({ messages: [...all.slice(0, -1), fn(all[all.length - 1])] });
    };
    try {
      const payload = history.map(({ role, content, sent }) => ({ role, content: sent ?? content }));
      for await (const ev of streamChat(this.bucket, payload, conv, ac.signal)) {
        if (ev.type === "meta") patch((m) => ({ ...m, model: ev.model, tier: ev.tier }));
        else if (ev.type === "text") patch((m) => ({ ...m, content: m.content + ev.delta }));
        else if (ev.type === "usage") patch((m) => ({ ...m, usage: ev.usage, tier: ev.tier }));
        else if (ev.type === "error") patch((m) => ({ ...m, error: ev.message }));
      }
    } catch (e) {
      patch((m) => ({ ...m, error: ac.signal.aborted ? m.error ?? (m.content ? undefined : "Остановлено") : (e as Error).message }));
    } finally {
      patch((m) => ({ ...m, at: new Date().toISOString() }));
      this.abort = null;
      this.set({ busy: false });
      await this.persist();
    }
  }
}

const controllers: Partial<Record<ChatBucket, ChatController>> = {};
export function chatController(bucket: ChatBucket) {
  return (controllers[bucket] ??= new ChatController(bucket));
}

export function useChat(bucket: ChatBucket) {
  const c = chatController(bucket);
  const snap = useSyncExternalStore(c.subscribe, c.get);
  return { ...snap, chat: c };
}
