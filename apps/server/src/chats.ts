// Saved chat conversations: data/chats/<bucket>/<id>.json, one file per conversation.
// The UI keeps several conversations per chat; "new chat" starts another file, older ones stay.
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { HttpError, type ChatBucket } from "@trellis/core";

const BUCKETS: ChatBucket[] = ["main", "dev"];
const ID_RE = /^[\w-]{1,64}$/;
const MAX_MESSAGES = 400;
const MAX_BYTES = 4_000_000;
/** Conversations kept per chat; the oldest are dropped beyond this. */
const MAX_CONVERSATIONS = 200;

export interface StoredConversation {
  schema: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Messages as the UI shows them; the server only checks shape and size. */
  messages: Record<string, unknown>[];
}
export type ConversationMeta = Pick<StoredConversation, "id" | "title" | "createdAt" | "updatedAt"> & { count: number };

const bucketOf = (b: string) => {
  if (!BUCKETS.includes(b as ChatBucket)) throw new HttpError(400, "unknown bucket");
  return b as ChatBucket;
};
const idOf = (id: string) => {
  if (!ID_RE.test(id)) throw new HttpError(400, "bad chat id");
  return id;
};

export class ChatStore {
  constructor(private readonly dir: string) {}

  private file(bucket: ChatBucket, id: string) {
    return join(this.dir, bucket, `${id}.json`);
  }

  async get(bucket: ChatBucket, id: string): Promise<StoredConversation | null> {
    try {
      return JSON.parse(await readFile(this.file(bucket, id), "utf8")) as StoredConversation;
    } catch {
      return null;
    }
  }

  async list(bucket: ChatBucket): Promise<ConversationMeta[]> {
    let names: string[] = [];
    try {
      names = (await readdir(join(this.dir, bucket))).filter((n) => n.endsWith(".json"));
    } catch {
      return [];
    }
    const items: ConversationMeta[] = [];
    for (const n of names) {
      const c = await this.get(bucket, n.slice(0, -5));
      if (c) items.push({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, count: c.messages.length });
    }
    return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async save(bucket: ChatBucket, id: string, body: { title?: unknown; messages?: unknown }): Promise<ConversationMeta> {
    if (!Array.isArray(body.messages) || body.messages.length > MAX_MESSAGES) throw new HttpError(400, `messages: array, up to ${MAX_MESSAGES}`);
    const messages = body.messages.map((m) => {
      if (!m || typeof m !== "object" || Array.isArray(m)) throw new HttpError(400, "message must be an object");
      const r = (m as Record<string, unknown>).role;
      if (r !== "user" && r !== "assistant") throw new HttpError(400, "role must be user or assistant");
      return m as Record<string, unknown>;
    });
    const prev = await this.get(bucket, id);
    const now = new Date().toISOString();
    const firstUser = messages.find((m) => m.role === "user")?.content;
    const title = typeof body.title === "string" && body.title.trim()
      ? body.title.trim().slice(0, 120)
      : prev?.title && prev.title !== "Новый чат" ? prev.title
      : typeof firstUser === "string" && firstUser.trim() ? firstUser.trim().replace(/\s+/g, " ").slice(0, 60) : "Новый чат";
    const conv: StoredConversation = { schema: 1, id, title, createdAt: prev?.createdAt ?? now, updatedAt: now, messages };
    const json = JSON.stringify(conv);
    if (json.length > MAX_BYTES) throw new HttpError(413, "Чат слишком большой: начните новый");
    await mkdir(join(this.dir, bucket), { recursive: true });
    const file = this.file(bucket, id);
    await writeFile(`${file}.tmp`, json, { encoding: "utf8", mode: 0o600 });
    await rename(`${file}.tmp`, file);
    await this.prune(bucket);
    return { id, title, createdAt: conv.createdAt, updatedAt: now, count: messages.length };
  }

  async remove(bucket: ChatBucket, id: string) {
    await rm(this.file(bucket, id), { force: true });
  }

  private async prune(bucket: ChatBucket) {
    const all = await this.list(bucket);
    for (const c of all.slice(MAX_CONVERSATIONS)) await this.remove(bucket, c.id);
  }
}

export function registerChats(app: FastifyInstance, dataDir: string) {
  const store = new ChatStore(join(dataDir, "chats"));
  type P = { bucket: string; id: string };
  app.get("/api/chats/:bucket", async (req) => ({ items: await store.list(bucketOf((req.params as P).bucket)) }));
  app.get("/api/chats/:bucket/:id", async (req) => {
    const p = req.params as P;
    const c = await store.get(bucketOf(p.bucket), idOf(p.id));
    if (!c) throw new HttpError(404, "Чат не найден");
    return c;
  });
  app.put("/api/chats/:bucket/:id", { bodyLimit: MAX_BYTES + 100_000 }, async (req) => {
    const p = req.params as P;
    return store.save(bucketOf(p.bucket), idOf(p.id), (req.body ?? {}) as Record<string, unknown>);
  });
  app.delete("/api/chats/:bucket/:id", async (req) => {
    const p = req.params as P;
    await store.remove(bucketOf(p.bucket), idOf(p.id));
    return { ok: true };
  });
  return store;
}
