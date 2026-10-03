// Confirmed write-back to external systems (Qase, Jira, Confluence).
// A change is first a proposal: the server reads the live record and stores what it is now and what it
// would become. Nothing is written until a person confirms. On apply the record is read again; if someone
// edited it in the meantime, the proposal turns into a conflict instead of overwriting their edit.
// Every outcome goes to an audit log in the connector's data folder.
import { createHash, randomUUID } from "node:crypto";
import { HttpError, type DocRecord, type ServerModuleContext, type TestCaseRecord } from "@trellis/core";

export interface StepInput { action: string; expected: string; data?: string }
export interface ChangeRequest {
  target: "case" | "doc";
  /** Trellis id, e.g. "qase:DEMO-12", "jira:PRJ-7", "confluence:SPACE:123". */
  id: string;
  reason: string;
  title?: string;
  preconditions?: string;
  steps?: StepInput[];
  /** Exact fragment of the current text and what to put instead. */
  find?: string;
  replace?: string;
  /** Where the proposal came from: chat, workbench, … */
  origin?: string;
  /** A new record instead of an edit: `id` then names the project ("qase:DEMO"), `container` the suite or folder. */
  create?: boolean;
  container?: string;
}
/** Readable fields for the diff: name → text. */
export type Fields = Record<string, string>;
export interface Live<R = unknown> {
  fields: Fields;
  raw: R;
  /** Remote version marker; when missing, a hash of `fields` is used to spot edits made by others. */
  version?: string;
}
export interface Adapter<R = unknown> {
  source: string;
  read(req: ChangeRequest): Promise<Live<R>>;
  /** New values of the fields that change; throw HttpError(422) when the change can't be expressed. */
  plan(live: Live<R>, req: ChangeRequest): Fields | Promise<Fields>;
  /** `after` is what `plan` returned; structured parts (steps) come from `req`. */
  write(live: Live<R>, after: Fields, req: ChangeRequest): Promise<void>;
  /** Fresh local records after a write, so Trellis shows the new text without a full sync. */
  local?(req: ChangeRequest): Promise<{ doc?: DocRecord; case?: TestCaseRecord }>;
  url?(req: ChangeRequest): string | undefined | Promise<string | undefined>;
  /** Creating records (`req.create`): `planCreate` checks the request and returns the fields to show, `create` writes. */
  planCreate?(req: ChangeRequest): Promise<Fields>;
  create?(req: ChangeRequest, fields: Fields): Promise<{ id: string; url?: string; doc?: DocRecord; case?: TestCaseRecord }>;
}

export type ChangeStatus = "proposed" | "applied" | "discarded" | "conflict" | "failed";
export interface Proposal {
  pid: string;
  source: string;
  request: ChangeRequest;
  before: Fields;
  after: Fields;
  fingerprint: string;
  status: ChangeStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
  url?: string;
  /** Id of the record a confirmed `create` made. */
  createdId?: string;
}
export interface AuditEntry { at: string; pid: string; id: string; action: ChangeStatus; note: string }

const MAX_PROPOSALS = 300;
const MAX_AUDIT = 2000;
const hash = (v: unknown) => createHash("sha1").update(JSON.stringify(v)).digest("hex").slice(0, 20);
const fingerprint = (l: Live) => l.version ?? hash(l.fields);

function text(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${field}: нужна строка`);
  if (v.length > max) throw new HttpError(400, `${field}: длиннее ${max} символов`);
  return v;
}

/** Checks the shape of a request coming from the chat or the UI. */
export function parseRequest(body: unknown, source: string): ChangeRequest {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.target !== "case" && b.target !== "doc") throw new HttpError(400, "target: case | doc");
  const id = text(b.id, "id", 200)?.trim();
  if (!id || !id.startsWith(`${source}:`)) throw new HttpError(400, `id должен начинаться с «${source}:»`);
  const reason = text(b.reason, "reason", 2000)?.trim() ?? "";
  if (!reason) throw new HttpError(400, "Укажите причину правки (reason)");
  let steps: StepInput[] | undefined;
  if (b.steps !== undefined) {
    if (!Array.isArray(b.steps) || b.steps.length > 100) throw new HttpError(400, "steps: массив до 100 шагов");
    steps = b.steps.map((s, i) => {
      const o = (s ?? {}) as Record<string, unknown>;
      const action = text(o.action, `steps[${i}].action`, 4000)?.trim() ?? "";
      if (!action) throw new HttpError(400, `steps[${i}].action пустой`);
      const data = text(o.data, `steps[${i}].data`, 4000)?.trim();
      return { action, expected: text(o.expected, `steps[${i}].expected`, 4000)?.trim() ?? "", ...(data ? { data } : {}) };
    });
  }
  const req: ChangeRequest = {
    target: b.target, id, reason,
    title: text(b.title, "title", 500)?.trim(),
    preconditions: text(b.preconditions, "preconditions", 10_000),
    steps,
    find: text(b.find, "find", 20_000),
    replace: text(b.replace, "replace", 20_000),
    origin: text(b.origin, "origin", 40),
    ...(b.create === true ? { create: true, container: text(b.container, "container", 500)?.trim() || undefined } : {}),
  };
  if (req.create) {
    if (!req.title) throw new HttpError(400, "У нового кейса должно быть название (title)");
    if (req.find !== undefined) throw new HttpError(400, "find/replace — для правки существующей записи, не для новой");
    return req;
  }
  if ((req.find === undefined) !== (req.replace === undefined)) throw new HttpError(400, "find и replace задаются вместе");
  if (req.find !== undefined && !req.find.trim()) throw new HttpError(400, "find пустой");
  if (req.title === undefined && req.preconditions === undefined && !req.steps && req.find === undefined) {
    throw new HttpError(400, "Нечего менять: укажите title, preconditions, steps или find/replace");
  }
  return req;
}

/** Replaces exactly one occurrence; a missing or repeated fragment is an error, never a guess. */
export function replaceOnce(source: string, find: string, replace: string, what = "тексте"): string {
  const at = source.indexOf(find);
  if (at < 0) throw new HttpError(422, `Фрагмент не найден в ${what} дословно. Возьмите фрагмент короче, из одного абзаца, без форматирования.`);
  if (source.indexOf(find, at + find.length) >= 0) throw new HttpError(422, `Фрагмент встречается в ${what} несколько раз: добавьте соседние слова, чтобы он был единственным.`);
  return source.slice(0, at) + replace + source.slice(at + find.length);
}

export function stepsText(steps: StepInput[]): string {
  return steps.map((s, i) => [
    `${i + 1}. ${s.action}`,
    s.data ? `   Данные: ${s.data}` : "",
    s.expected ? `   Ожидается: ${s.expected}` : "",
  ].filter(Boolean).join("\n")).join("\n");
}

/** Swaps one record in the local copy of a source, keeping the rest of the snapshot. */
async function replaceLocal(ctx: ServerModuleContext, source: string, fresh: { doc?: DocRecord; case?: TestCaseRecord }) {
  const info = (await ctx.data.sources()).find((s) => s.source === source);
  if (!info) return;
  const [docs, cases] = await Promise.all([ctx.data.docs(), ctx.data.cases()]);
  const swap = <T extends { id: string; source: string }>(all: T[], rec?: T) => {
    const mine = all.filter((x) => x.source === source);
    if (rec && !mine.some((x) => x.id === rec.id)) return [...mine, rec]; // a created record
    return mine.map((x) => (rec && x.id === rec.id ? rec : x));
  };
  await ctx.data.replace({ source, title: info.title, syncedAt: info.syncedAt, docs: swap(docs, fresh.doc), cases: swap(cases, fresh.case) });
}

/** Mounts /changes routes on a connector. */
export function registerChanges<R>(ctx: ServerModuleContext, adapter: Adapter<R>) {
  let proposals: Proposal[] = [];
  const loaded = ctx.files.read<Proposal[]>("changes").then((p) => void (proposals = p ?? []));
  const busy = new Set<string>();
  const save = () => ctx.files.write("changes", proposals);
  const audit = async (p: Proposal, note: string) => {
    const log = (await ctx.files.read<AuditEntry[]>("audit")) ?? [];
    log.push({ at: new Date().toISOString(), pid: p.pid, id: p.request.id, action: p.status, note: note.slice(0, 500) });
    await ctx.files.write("audit", log.slice(-MAX_AUDIT));
    ctx.log(`change ${p.status}: ${p.request.id} (${p.pid}) ${note}`.slice(0, 300));
  };
  const find = async (pid: string) => {
    await loaded;
    const p = proposals.find((x) => x.pid === pid);
    if (!p) throw new HttpError(404, "Предложение не найдено");
    return p;
  };
  const set = async (p: Proposal, status: ChangeStatus, note: string, error?: string) => {
    p.status = status;
    p.updatedAt = new Date().toISOString();
    if (error) p.error = error;
    else delete p.error;
    await save();
    await audit(p, error ? `${note}: ${error}` : note);
  };

  ctx.route("GET", "/changes", async ({ query }) => {
    await loaded;
    return { items: proposals.filter((p) => !query.status || p.status === query.status).slice().reverse() };
  });
  ctx.route("GET", "/changes/:pid", async ({ params }) => find(params.pid));
  ctx.route("GET", "/changes-audit", async () => ({ items: ((await ctx.files.read<AuditEntry[]>("audit")) ?? []).slice(-300).reverse() }));

  /** Two cases with one title are almost always a double send, not a wish. */
  const duplicate = async (title: string) => {
    const t = title.trim().toLowerCase();
    return (await ctx.data.cases()).find((c) => c.source === adapter.source && c.title.trim().toLowerCase() === t);
  };
  const planCreate = async (req: ChangeRequest) => {
    if (!adapter.planCreate || !adapter.create) throw new HttpError(422, `${adapter.source}: создание новых записей не поддерживается`);
    const dup = await duplicate(req.title!);
    if (dup) throw new HttpError(409, `Кейс «${dup.title}» уже есть (${dup.externalId}). Измените название или правьте существующий кейс.`);
    return adapter.planCreate(req);
  };

  ctx.route("POST", "/changes", async ({ body }) => {
    await loaded;
    const req = parseRequest(body, adapter.source);
    if (req.create) {
      const fields = Object.fromEntries(Object.entries(await planCreate(req)).filter(([, v]) => v));
      const now = new Date().toISOString();
      const p: Proposal = {
        pid: randomUUID(), source: adapter.source, request: req, before: {}, after: fields,
        fingerprint: "new", status: "proposed", createdAt: now, updatedAt: now,
      };
      proposals.push(p);
      if (proposals.length > MAX_PROPOSALS) {
        const drop = proposals.find((x) => x.status !== "proposed") ?? proposals[0];
        proposals = proposals.filter((x) => x !== drop);
      }
      await save();
      await audit(p, `предложен новый кейс (${req.origin ?? "ui"}): ${req.reason}`);
      return p;
    }
    const live = await adapter.read(req);
    const after = await adapter.plan(live, req);
    const changed = Object.keys(after).filter((k) => after[k] !== live.fields[k]);
    if (!changed.length) throw new HttpError(422, "Правка ничего не меняет: текст уже такой");
    const now = new Date().toISOString();
    const p: Proposal = {
      pid: randomUUID(), source: adapter.source, request: req,
      before: Object.fromEntries(changed.map((k) => [k, live.fields[k] ?? ""])),
      after: Object.fromEntries(changed.map((k) => [k, after[k]])),
      fingerprint: fingerprint(live), status: "proposed", createdAt: now, updatedAt: now, url: await adapter.url?.(req),
    };
    // Older proposals beyond the limit go first, open ones last.
    proposals.push(p);
    if (proposals.length > MAX_PROPOSALS) {
      const drop = proposals.find((x) => x.status !== "proposed") ?? proposals[0];
      proposals = proposals.filter((x) => x !== drop);
    }
    await save();
    await audit(p, `предложено (${req.origin ?? "ui"}): ${req.reason}`);
    return p;
  });

  ctx.route("POST", "/changes/:pid/apply", async ({ params, body }) => {
    const p = await find(params.pid);
    if ((body as Record<string, unknown> | undefined)?.confirm !== true) throw new HttpError(400, "Нужно явное подтверждение: { confirm: true }");
    if (p.status !== "proposed" && p.status !== "failed") throw new HttpError(409, `Предложение уже в статусе «${p.status}»`);
    if (busy.has(p.pid)) throw new HttpError(409, "Запись уже идёт");
    busy.add(p.pid);
    try {
      if (p.request.create) {
        // Checked again: someone may have created the same case since the proposal.
        let fields: Fields;
        try {
          fields = await planCreate(p.request);
        } catch (e) {
          await set(p, "conflict", "не создано", (e as Error).message);
          throw e;
        }
        let made: Awaited<ReturnType<NonNullable<Adapter["create"]>>>;
        try {
          made = await adapter.create!(p.request, fields);
        } catch (e) {
          await set(p, "failed", "ошибка создания", (e as Error).message);
          throw e;
        }
        p.createdId = made.id;
        p.url = made.url;
        await set(p, "applied", `создано: ${made.id}`);
        try {
          if (made.case || made.doc) await replaceLocal(ctx, adapter.source, made);
        } catch (e) {
          ctx.log(`change ${p.pid}: local copy not refreshed: ${(e as Error).message}`);
        }
        return p;
      }
      const live = await adapter.read(p.request);
      if (fingerprint(live) !== p.fingerprint) {
        await set(p, "conflict", "не записано", "Запись изменили после предложения. Создайте новое предложение по свежему тексту.");
        throw new HttpError(409, p.error!);
      }
      // Planned again on the live record; it must give exactly what the person confirmed.
      const after = await adapter.plan(live, p.request);
      if (Object.keys(p.after).some((k) => after[k] !== p.after[k])) {
        await set(p, "conflict", "не записано", "Результат правки отличается от показанного. Создайте новое предложение.");
        throw new HttpError(409, p.error!);
      }
      try {
        await adapter.write(live, after, p.request);
      } catch (e) {
        await set(p, "failed", "ошибка записи", (e as Error).message);
        throw e;
      }
      await set(p, "applied", "записано");
      try {
        if (adapter.local) await replaceLocal(ctx, adapter.source, await adapter.local(p.request));
      } catch (e) {
        ctx.log(`change ${p.pid}: local copy not refreshed: ${(e as Error).message}`);
      }
      return p;
    } finally {
      busy.delete(p.pid);
    }
  });

  ctx.route("POST", "/changes/:pid/discard", async ({ params }) => {
    const p = await find(params.pid);
    if (p.status === "applied") throw new HttpError(409, "Правка уже записана");
    await set(p, "discarded", "отклонено");
    return p;
  });
}
