import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocRecord, ServerModuleContext, SourceSnapshot, TestCaseRecord } from "@trellis/core";
import { parseRequest, registerChanges, replaceOnce, type Adapter, type Proposal } from "./index.ts";

type Handler = (req: { params: Record<string, string>; query: Record<string, string | undefined>; body: unknown }) => Promise<unknown>;

function fakeCtx() {
  const routes = new Map<string, Handler>();
  const files = new Map<string, unknown>();
  let snapshot: SourceSnapshot = {
    source: "demo", title: "Demo", syncedAt: "2026-01-01",
    docs: [], cases: [{ id: "demo:A-1", source: "demo", externalId: "A-1", title: "Old", state: "", suites: ["S"], steps: [] }],
  };
  const ctx = {
    route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h),
    files: { read: async (n: string) => files.get(n) ?? null, write: async (n: string, v: unknown) => void files.set(n, structuredClone(v)) },
    data: {
      sources: async () => [{ source: "demo", title: "Demo", syncedAt: "2026-01-01", docs: 0, cases: 1 }],
      docs: async () => snapshot.docs as DocRecord[],
      cases: async () => snapshot.cases as TestCaseRecord[],
      replace: async (s: SourceSnapshot) => void (snapshot = s),
    },
    log: () => {},
  } as unknown as ServerModuleContext;
  const call = (m: string, p: string, params: Record<string, string> = {}, body?: unknown) =>
    routes.get(`${m} ${p}`)!({ params, query: {}, body });
  return { ctx, call, files, snapshot: () => snapshot };
}

function remote() {
  const rec = { title: "Old", writes: 0 };
  const adapter: Adapter<typeof rec> = {
    source: "demo",
    read: async () => ({ raw: rec, fields: { title: rec.title } }),
    plan: (_l, req): Record<string, string> => (req.title !== undefined ? { title: req.title } : {}),
    write: async (_l, after) => void ((rec.title = after.title), rec.writes++),
    local: async (req) => ({ case: { id: req.id, source: "demo", externalId: "A-1", title: rec.title, state: "", suites: ["S"], steps: [] } }),
  };
  return { rec, adapter };
}

const req = { target: "case", id: "demo:A-1", title: "New", reason: "уточнение" };

test("nothing is written until confirmed; apply writes, refreshes the local copy and logs", async () => {
  const { ctx, call, files, snapshot } = fakeCtx();
  const { rec, adapter } = remote();
  registerChanges(ctx, adapter);
  const p = (await call("POST", "/changes", {}, req)) as Proposal;
  assert.deepEqual([p.before, p.after, p.status], [{ title: "Old" }, { title: "New" }, "proposed"]);
  assert.equal(rec.writes, 0);
  await assert.rejects(call("POST", "/changes/:pid/apply", { pid: p.pid }, {}), /подтверждение/);
  const done = (await call("POST", "/changes/:pid/apply", { pid: p.pid }, { confirm: true })) as Proposal;
  assert.equal(done.status, "applied");
  assert.equal(rec.title, "New");
  assert.equal(snapshot().cases[0].title, "New");
  assert.deepEqual((files.get("audit") as { action: string }[]).map((a) => a.action), ["proposed", "applied"]);
  await assert.rejects(call("POST", "/changes/:pid/apply", { pid: p.pid }, { confirm: true }), /applied/);
});

test("an edit made by someone else after the proposal is a conflict, not an overwrite", async () => {
  const { ctx, call } = fakeCtx();
  const { rec, adapter } = remote();
  registerChanges(ctx, adapter);
  const p = (await call("POST", "/changes", {}, req)) as Proposal;
  rec.title = "Changed in Qase";
  await assert.rejects(call("POST", "/changes/:pid/apply", { pid: p.pid }, { confirm: true }), /изменили/);
  assert.equal(rec.title, "Changed in Qase");
  assert.equal(rec.writes, 0);
});

test("a change that changes nothing is refused", async () => {
  const { ctx, call } = fakeCtx();
  const { adapter } = remote();
  registerChanges(ctx, adapter);
  await assert.rejects(call("POST", "/changes", {}, { ...req, title: "Old" }), /ничего не меняет/);
});

test("requests are checked", () => {
  assert.throws(() => parseRequest({ ...req, id: "other:1" }, "demo"), /demo:/);
  assert.throws(() => parseRequest({ ...req, reason: "" }, "demo"), /причину/);
  assert.throws(() => parseRequest({ target: "case", id: "demo:A-1", reason: "x" }, "demo"), /Нечего менять/);
  assert.throws(() => parseRequest({ ...req, find: "a" }, "demo"), /вместе/);
  assert.deepEqual(parseRequest({ ...req, steps: [{ action: " Открыть ", expected: "Открыто" }] }, "demo").steps, [{ action: "Открыть", expected: "Открыто" }]);
});

test("replaceOnce needs exactly one match", () => {
  assert.equal(replaceOnce("a b c", "b", "x"), "a x c");
  assert.throws(() => replaceOnce("a b c", "z", "x"), /не найден/);
  assert.throws(() => replaceOnce("b b", "b", "x"), /несколько/);
});
