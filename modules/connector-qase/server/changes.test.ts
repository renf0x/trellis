import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServerModuleContext, SourceSnapshot, TestCaseRecord } from "@trellis/core";
import { register } from "./index.ts";

type Handler = (req: { params: Record<string, string>; query: Record<string, string | undefined>; body: unknown }) => Promise<unknown>;

function setup(remote: Record<string, unknown>) {
  const routes = new Map<string, Handler>();
  const files = new Map<string, unknown>([["settings", { host: "https://api.qase.io", project: "DEMO", suitesAsDocs: false }]]);
  let snap: SourceSnapshot = {
    source: "qase", title: "Qase · DEMO", syncedAt: "2026-01-01", docs: [],
    cases: [{ id: "qase:DEMO-7", source: "qase", externalId: "DEMO-7", title: "Вход", state: "", suites: ["DEMO / Auth"], steps: [] }],
  };
  const ctx = {
    route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h),
    files: { read: async (n: string) => files.get(n) ?? null, write: async (n: string, v: unknown) => void files.set(n, structuredClone(v)) },
    secrets: { get: async () => ({ token: "test-token" }), set: async () => {} },
    data: {
      sources: async () => [{ source: "qase", title: snap.title, syncedAt: snap.syncedAt, docs: 0, cases: 1 }],
      docs: async () => snap.docs,
      cases: async () => snap.cases as TestCaseRecord[],
      replace: async (s: SourceSnapshot) => void (snap = s),
    },
    log: () => {},
  } as unknown as ServerModuleContext;
  const patches: unknown[] = [];
  const created: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname === "/v1/suite/DEMO") {
      return Response.json({ status: true, result: { total: 2, count: 2, entities: [{ id: 3, title: "Auth" }, { id: 5, title: "Вход", parent_id: 3 }] } });
    }
    if (u.pathname === "/v1/case/DEMO" && init?.method === "POST") {
      created.push(JSON.parse(String(init.body)));
      return Response.json({ status: true, result: { id: 40 + created.length } });
    }
    if (u.pathname !== "/v1/case/DEMO/7") return new Response("{}", { status: 404 });
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      patches.push(body);
      Object.assign(remote, body);
      return Response.json({ status: true, result: { id: 7 } });
    }
    return Response.json({ status: true, result: remote });
  }) as typeof fetch;
  register(ctx);
  const call = (m: string, p: string, params: Record<string, string> = {}, body?: unknown) => routes.get(`${m} ${p}`)!({ params, query: {}, body });
  return { call, patches, created, snap: () => snap, restore: () => void (globalThis.fetch = realFetch) };
}

test("a Qase case edit is proposed with a diff, written on confirm, and the local copy follows", async () => {
  const remote = { id: 7, title: "Вход", preconditions: "Пользователь создан", steps: [{ position: 1, action: "Открыть форму", expected_result: "Открыта" }] };
  const t = setup(remote);
  try {
    const p = (await t.call("POST", "/changes", {}, {
      target: "case", id: "qase:DEMO-7", reason: "Нет проверки ошибки",
      steps: [{ action: "Открыть форму", expected: "Открыта" }, { action: "Ввести неверный пароль", expected: "Ошибка «Неверный пароль»" }],
    })) as { pid: string; before: Record<string, string>; after: Record<string, string> };
    assert.deepEqual(Object.keys(p.after), ["steps"]);
    assert.match(p.after.steps, /2\. Ввести неверный пароль/);
    assert.equal(t.patches.length, 0);
    await t.call("POST", "/changes/:pid/apply", { pid: p.pid }, { confirm: true });
    assert.deepEqual(t.patches, [{ steps: [
      { position: 1, action: "Открыть форму", expected_result: "Открыта", data: "" },
      { position: 2, action: "Ввести неверный пароль", expected_result: "Ошибка «Неверный пароль»", data: "" },
    ] }]);
    const local = t.snap().cases[0];
    assert.equal(local.steps.length, 3); // precondition shown as the first step
    assert.deepEqual(local.suites, ["DEMO / Auth"]);
  } finally {
    t.restore();
  }
});

test("find/replace touches preconditions only; nested steps are refused", async () => {
  const t = setup({ id: 7, title: "Вход", preconditions: "Пользователь создан", steps: [{ action: "A", steps: [{ action: "B" }] }] });
  try {
    const p = (await t.call("POST", "/changes", {}, { target: "case", id: "qase:DEMO-7", reason: "r", find: "создан", replace: "создан и активирован" })) as { after: Record<string, string> };
    assert.deepEqual(p.after, { preconditions: "Пользователь создан и активирован" });
    await assert.rejects(t.call("POST", "/changes", {}, { target: "case", id: "qase:DEMO-7", reason: "r", steps: [{ action: "X", expected: "" }] }), /вложенные/);
    await assert.rejects(t.call("POST", "/changes", {}, { target: "doc", id: "qase:DEMO:suite-1", reason: "r", title: "x" }), /только тест-кейсы/);
  } finally {
    t.restore();
  }
});

test("a new case is created only on confirm, in the suite found by path, and never twice", async () => {
  const t = setup({});
  try {
    const body = {
      target: "case", id: "qase:DEMO", create: true, container: "DEMO / auth / Вход", reason: "Требование 2.3 не покрыто", origin: "workbench",
      title: "Блокировка после 5 неудачных попыток", preconditions: "Пользователь создан",
      steps: [{ action: "Ввести неверный пароль 5 раз", expected: "Аккаунт заблокирован на 15 минут" }],
    };
    const p = (await t.call("POST", "/changes", {}, body)) as { pid: string; after: Record<string, string>; before: Record<string, string> };
    assert.equal(p.after.suite, "DEMO / Auth / Вход");
    assert.deepEqual(p.before, {});
    assert.equal(t.created.length, 0);
    await assert.rejects(t.call("POST", "/changes/:pid/apply", { pid: p.pid }, {}), /подтверждение/);
    const done = (await t.call("POST", "/changes/:pid/apply", { pid: p.pid }, { confirm: true })) as { createdId: string; status: string; url: string };
    assert.deepEqual([done.status, done.createdId, done.url], ["applied", "qase:DEMO-41", "https://app.qase.io/case/DEMO-41"]);
    assert.deepEqual(t.created, [{
      title: "Блокировка после 5 неудачных попыток", preconditions: "Пользователь создан", suite_id: 5,
      steps: [{ position: 1, action: "Ввести неверный пароль 5 раз", expected_result: "Аккаунт заблокирован на 15 минут", data: "" }],
    }]);
    const local = t.snap().cases.find((c) => c.id === "qase:DEMO-41")!;
    assert.deepEqual([local.suites, local.state, t.snap().cases.length], [["DEMO / Auth / Вход"], "Draft", 2]);
    // Applying again or proposing the same title again does not make a second case.
    await assert.rejects(t.call("POST", "/changes/:pid/apply", { pid: p.pid }, { confirm: true }), /уже в статусе/);
    await assert.rejects(t.call("POST", "/changes", {}, body), /уже есть \(DEMO-41\)/);
    await assert.rejects(t.call("POST", "/changes", {}, { ...body, title: "Другой", container: "Нет такого" }), /не найден/);
    assert.equal(t.created.length, 1);
  } finally {
    t.restore();
  }
});
