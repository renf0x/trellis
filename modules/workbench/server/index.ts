// Test-case workbench: drafts of new cases (often from an uncovered requirement) and edits of existing ones.
// Drafts live here until the tester sends them; sending goes through the connector's /changes proposal,
// so nothing reaches Qase without a confirm in the UI. Stored in one module file, "items".
import { randomUUID } from "node:crypto";
import { HttpError, type ServerModuleContext, type TestCaseRecord } from "@trellis/core";

export const STATUSES = ["todo", "in_progress", "clarify", "done", "sent"] as const;
export type Status = (typeof STATUSES)[number];
export interface Step { action: string; expected: string }
export interface Item {
  id: string;
  kind: "new" | "edit";
  /** Edit: the case being changed, e.g. "qase:DEMO-12". A sent new case gets the created id here. */
  caseId?: string;
  title: string;
  /** Suite path without the project code, "Auth / Вход"; empty means the project root. */
  suite: string;
  preconditions: string;
  steps: Step[];
  status: Status;
  note?: string;
  /** Where the draft came from: a requirement of the coverage analysis, a doc, free text. */
  source?: { requirementId?: string; docId?: string; docTitle?: string; text?: string };
  proposalId?: string;
  createdId?: string;
  url?: string;
  createdAt: string;
  updatedAt: string;
}

const PRE = /^Предусловие:\s*/;
const MAX_STEPS = 100;

function text(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  if (v.length > max) throw new HttpError(400, `${field} is longer than ${max}`);
  return v;
}

function steps(v: unknown): Step[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > MAX_STEPS) throw new HttpError(400, `steps must be a list of up to ${MAX_STEPS}`);
  return v.map((s, i) => {
    const o = (s ?? {}) as Record<string, unknown>;
    return { action: text(o.action, `steps[${i}].action`, 4000) ?? "", expected: text(o.expected, `steps[${i}].expected`, 4000) ?? "" };
  });
}

function source(v: unknown): Item["source"] {
  if (v === undefined || v === null) return undefined;
  const o = v as Record<string, unknown>;
  const s = {
    requirementId: text(o.requirementId, "source.requirementId", 100),
    docId: text(o.docId, "source.docId", 300),
    docTitle: text(o.docTitle, "source.docTitle", 300),
    text: text(o.text, "source.text", 4000),
  };
  return Object.values(s).some(Boolean) ? s : undefined;
}

/** "DEMO / Auth / Вход" → "Auth / Вход"; a case in the project root has just "DEMO". */
export function suiteOf(c: TestCaseRecord): string {
  const code = c.externalId.split("-")[0];
  const s = c.suites[0] ?? "";
  return s === code ? "" : s.startsWith(`${code} / `) ? s.slice(code.length + 3) : s;
}

/** A local case as a draft: the "Предусловие:" step Qase import adds goes back to its own field. */
export function draftOf(c: TestCaseRecord): Pick<Item, "title" | "suite" | "preconditions" | "steps"> {
  const first = c.steps[0];
  const pre = first && PRE.test(first.action) && !first.expected ? first.action.replace(PRE, "") : "";
  return {
    title: c.title,
    suite: c.source === "qase" ? suiteOf(c) : (c.suites[0] ?? ""),
    preconditions: pre,
    steps: (pre ? c.steps.slice(1) : c.steps).map((s) => ({ action: s.action, expected: s.expected })),
  };
}

const counts = (items: Item[]) =>
  Object.fromEntries(STATUSES.map((s) => [s, items.filter((i) => i.status === s).length])) as Record<Status, number>;

export function register(ctx: ServerModuleContext) {
  const load = async () => (await ctx.files.read<Item[]>("items")) ?? [];
  const save = (items: Item[]) => ctx.files.write("items", items);
  // One writer at a time, so two quick saves from the editor can't drop each other.
  let queue: Promise<unknown> = Promise.resolve();
  const edit = <T>(f: (items: Item[]) => Promise<T> | T): Promise<T> => {
    const next = queue.then(async () => {
      const items = await load();
      const out = await f(items);
      await save(items);
      return out;
    });
    queue = next.catch(() => {});
    return next;
  };
  const find = (items: Item[], id: string) => {
    const it = items.find((i) => i.id === id);
    if (!it) throw new HttpError(404, "Черновик не найден");
    return it;
  };

  ctx.route("GET", "/items", async ({ query }) => {
    const all = await load();
    const want = query.status?.split(",").filter((s): s is Status => (STATUSES as readonly string[]).includes(s));
    const items = (want?.length ? all.filter((i) => want.includes(i.status)) : all)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return { items, counts: counts(all) };
  });

  ctx.route("GET", "/items/:id", async ({ params }) => find(await load(), params.id));

  /** Suites seen in local Qase cases, for the suite field. */
  ctx.route("GET", "/suites", async () => {
    const set = new Set((await ctx.data.cases()).filter((c) => c.source === "qase").map(suiteOf).filter(Boolean));
    return { suites: [...set].sort((a, b) => a.localeCompare(b)) };
  });

  ctx.route("POST", "/items", async ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const kind = b.kind === "edit" ? "edit" : "new";
    const src = source(b.source);
    let base: Pick<Item, "title" | "suite" | "preconditions" | "steps"> = { title: "", suite: "", preconditions: "", steps: [] };
    let caseId: string | undefined;
    if (kind === "edit") {
      caseId = text(b.caseId, "caseId", 200);
      if (!caseId) throw new HttpError(400, "caseId is required");
      const c = (await ctx.data.cases()).find((x) => x.id === caseId);
      if (!c) throw new HttpError(404, `Кейс ${caseId} не найден в локальной копии`);
      base = draftOf(c);
    }
    return edit((items) => {
      // The same case or requirement already on the bench: open that draft instead of a twin.
      const twin = items.find((i) => i.status !== "sent" && (caseId
        ? i.caseId === caseId
        : src?.requirementId && i.source?.requirementId === src.requirementId));
      if (twin) return { ...twin, existing: true };
      const now = new Date().toISOString();
      const it: Item = {
        id: `W-${randomUUID().slice(0, 8)}`, kind, ...(caseId ? { caseId } : {}),
        title: text(b.title, "title", 500)?.trim() || base.title,
        suite: text(b.suite, "suite", 500)?.trim() ?? base.suite,
        preconditions: text(b.preconditions, "preconditions", 8000) ?? base.preconditions,
        steps: steps(b.steps) ?? base.steps,
        status: "todo",
        ...(text(b.note, "note", 4000) ? { note: b.note as string } : {}),
        ...(src ? { source: src } : {}),
        createdAt: now, updatedAt: now,
      };
      items.push(it);
      return it;
    });
  });

  ctx.route("POST", "/items/:id", async ({ params, body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    return edit((items) => {
      const it = find(items, params.id);
      if (b.status !== undefined) {
        if (!(STATUSES as readonly unknown[]).includes(b.status)) throw new HttpError(400, `unknown status ${String(b.status)}`);
        it.status = b.status as Status;
      }
      const title = text(b.title, "title", 500);
      if (title !== undefined) it.title = title;
      const suite = text(b.suite, "suite", 500);
      if (suite !== undefined) it.suite = suite.trim();
      const pre = text(b.preconditions, "preconditions", 8000);
      if (pre !== undefined) it.preconditions = pre;
      const st = steps(b.steps);
      if (st) it.steps = st;
      const note = text(b.note, "note", 4000);
      if (note !== undefined) it.note = note || undefined;
      const pid = text(b.proposalId, "proposalId", 100);
      if (pid !== undefined) it.proposalId = pid || undefined;
      const url = text(b.url, "url", 1000);
      if (url) it.url = url;
      // Sent: a new case now exists remotely, so the next send of this draft is an edit of it.
      const created = text(b.createdId, "createdId", 200);
      if (created) {
        it.createdId = created;
        it.kind = "edit";
        it.caseId = created;
      }
      it.updatedAt = new Date().toISOString();
      return it;
    });
  });

  const remove = async ({ params }: { params: Record<string, string> }) =>
    edit((items) => {
      find(items, params.id);
      items.splice(items.findIndex((i) => i.id === params.id), 1);
      return { ok: true };
    });
  ctx.route("DELETE", "/items/:id", remove);
  // The module UI api has no DELETE.
  ctx.route("POST", "/items/:id/delete", remove);
}
