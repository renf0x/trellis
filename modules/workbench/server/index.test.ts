import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerModuleContext, TestCaseRecord } from "@trellis/core";
import { draftOf, register, type Item } from "./index.ts";

type Handler = (req: { params: Record<string, string>; query: Record<string, string | undefined>; body: unknown }) => Promise<unknown>;

const CASE: TestCaseRecord = {
  id: "qase:DEMO-7", source: "qase", externalId: "DEMO-7", title: "Вход по паролю", state: "Actual",
  suites: ["DEMO / Auth / Вход"],
  steps: [
    { kind: "step", action: "Предусловие: Пользователь зарегистрирован", expected: "" },
    { kind: "step", action: "Ввести email и пароль", expected: "Открыт личный кабинет" },
  ],
};

function bench() {
  const routes = new Map<string, Handler>();
  const files = new Map<string, unknown>();
  register({
    route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h),
    files: { read: async (n: string) => structuredClone(files.get(n) ?? null), write: async (n: string, v: unknown) => void files.set(n, structuredClone(v)) },
    data: { cases: async () => [CASE, { ...CASE, id: "qase:DEMO-8", externalId: "DEMO-8", suites: ["DEMO"] }] },
    log: () => {},
  } as unknown as ServerModuleContext);
  const call = <T>(m: string, p: string, o: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) =>
    routes.get(`${m} ${p}`)!({ params: o.params ?? {}, query: o.query ?? {}, body: o.body }) as Promise<T>;
  return { call, files };
}

test("draftOf moves the imported precondition step back and strips the project from the suite", () => {
  assert.deepEqual(draftOf(CASE), {
    title: "Вход по паролю", suite: "Auth / Вход", preconditions: "Пользователь зарегистрирован",
    steps: [{ action: "Ввести email и пароль", expected: "Открыт личный кабинет" }],
  });
});

test("drafts: create, dedupe, edit, send, filter, delete", async () => {
  const { call, files } = bench();
  const req = { requirementId: "r1", docId: "d1", docTitle: "Вход", text: "После 5 попыток блокировка" };
  const n = await call<Item>("POST", "/items", { body: { kind: "new", title: "Блокировка после 5 попыток", source: req } });
  assert.deepEqual([n.kind, n.status, n.suite, n.steps.length], ["new", "todo", "", 0]);
  // The same requirement again opens the existing draft.
  const again = await call<Item & { existing?: boolean }>("POST", "/items", { body: { kind: "new", title: "x", source: req } });
  assert.equal(again.id, n.id);
  assert.equal(again.existing, true);

  const e = await call<Item>("POST", "/items", { body: { kind: "edit", caseId: "qase:DEMO-7" } });
  assert.deepEqual([e.kind, e.caseId, e.preconditions, e.suite], ["edit", "qase:DEMO-7", "Пользователь зарегистрирован", "Auth / Вход"]);
  await assert.rejects(call("POST", "/items", { body: { kind: "edit", caseId: "qase:NOPE-1" } }), /не найден/);
  const root = await call<Item>("POST", "/items", { body: { kind: "edit", caseId: "qase:DEMO-8" } });
  assert.equal(root.suite, "");

  const upd = await call<Item>("POST", "/items/:id", { params: { id: n.id }, body: {
    status: "in_progress", suite: " Auth ", steps: [{ action: "Ввести неверный пароль 5 раз", expected: "Аккаунт заблокирован" }],
  } });
  assert.deepEqual([upd.status, upd.suite, upd.steps.length], ["in_progress", "Auth", 1]);
  await assert.rejects(call("POST", "/items/:id", { params: { id: n.id }, body: { status: "zzz" } }), /unknown status/);
  await assert.rejects(call("POST", "/items/:id", { params: { id: n.id }, body: { steps: "x" } }), /steps/);

  // Sent: the new case now exists, the draft becomes an edit of it.
  const sent = await call<Item>("POST", "/items/:id", { params: { id: n.id }, body: { status: "sent", createdId: "qase:DEMO-41", url: "https://app.qase.io/case/DEMO-41" } });
  assert.deepEqual([sent.kind, sent.caseId, sent.createdId, sent.status], ["edit", "qase:DEMO-41", "qase:DEMO-41", "sent"]);
  // A sent draft no longer blocks a new one for the same requirement.
  const fresh = await call<Item>("POST", "/items", { body: { kind: "new", title: "Ещё один", source: req } });
  assert.notEqual(fresh.id, n.id);

  const list = await call<{ items: Item[]; counts: Record<string, number> }>("GET", "/items", { query: { status: "todo" } });
  assert.equal(list.items.length, 3);
  assert.deepEqual(list.counts, { todo: 3, in_progress: 0, clarify: 0, done: 0, sent: 1 });

  await call("POST", "/items/:id/delete", { params: { id: fresh.id } });
  await assert.rejects(call("GET", "/items/:id", { params: { id: fresh.id } }), /не найден/);
  assert.equal((files.get("items") as Item[]).length, 3);

  const suites = await call<{ suites: string[] }>("GET", "/suites");
  assert.deepEqual(suites.suites, ["Auth / Вход"]);
});

test("parallel saves don't drop each other", async () => {
  const { call } = bench();
  const made = await Promise.all(Array.from({ length: 5 }, (_, i) => call<Item>("POST", "/items", { body: { title: `Кейс ${i}` } })));
  await Promise.all(made.map((m, i) => call("POST", "/items/:id", { params: { id: m.id }, body: { note: `n${i}` } })));
  const { items } = await call<{ items: Item[] }>("GET", "/items");
  assert.equal(items.length, 5);
  assert.ok(items.every((i) => i.note?.startsWith("n")));
});
