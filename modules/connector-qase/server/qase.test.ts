import { test } from "node:test";
import assert from "node:assert/strict";
import { QaseClient, flattenSteps, normalizeHost, suitePaths, testConnection } from "./qase.ts";
import { suiteDoc, toCase } from "./index.ts";

test("normalizeHost maps the app link to the API", () => {
  assert.equal(normalizeHost(""), "https://api.qase.io");
  assert.equal(normalizeHost("https://app.qase.io/project/DEMO"), "https://api.qase.io");
  assert.equal(normalizeHost("api.qase.company.ru/"), "https://api.qase.company.ru");
});

test("steps are ordered, nested steps flattened, test data kept", () => {
  assert.deepEqual(flattenSteps([
    { position: 2, action: "Нажать войти", expected_result: "Ошибка", steps: [{ position: 1, action: "Проверить текст", expected_result: "Неверный пароль" }] },
    { position: 1, action: "Ввести пароль", data: "qwerty", expected_result: "" },
  ]), [
    { action: "Ввести пароль\nДанные: qwerty", expected: "" },
    { action: "Нажать войти", expected: "Ошибка" },
    { action: "2.Проверить текст", expected: "Неверный пароль" },
  ]);
});

function fake(routes: Record<string, (u: URL) => unknown>, calls: string[] = []): typeof fetch {
  return (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(`${u.pathname}${u.search}|${(init?.headers as Record<string, string>)?.Token ?? ""}`);
    const key = Object.keys(routes).find((k) => u.pathname === k);
    if (!key) return new Response(JSON.stringify({ status: false, errorMessage: "Project not found" }), { status: 404 });
    const r = routes[key](u);
    return r instanceof Response ? r : Response.json({ status: true, result: r });
  }) as typeof fetch;
}

test("all() pages with limit/offset and sends the Token header", async () => {
  const calls: string[] = [];
  const page = (offset: number) => Array.from({ length: offset === 0 ? 100 : 5 }, (_, i) => ({ id: offset + i + 1, title: "t" }));
  const c = new QaseClient("https://api.qase.io", "tok", fake({
    "/v1/case/DEMO": (u) => ({ total: 105, count: 0, entities: page(Number(u.searchParams.get("offset"))) }),
  }, calls));
  const all = await c.all<{ id: number }>("case/DEMO");
  assert.equal(all.length, 105);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].endsWith("|tok"));
  assert.match(calls[1], /offset=100/);
});

test("check: bad token stops after the token step; unknown project is reported", async () => {
  const bad = await testConnection(new QaseClient("https://api.qase.io", "x", fake({
    "/v1/project": () => new Response("{}", { status: 401 }),
  })), "DEMO");
  assert.deepEqual(bad.steps.map((s) => `${s.id}:${s.ok}`), ["auth:false"]);
  assert.match(bad.steps[0].message, /API tokens/);

  const r = await testConnection(new QaseClient("https://api.qase.io", "t", fake({
    "/v1/project": () => ({ total: 1, entities: [] }),
  })), "NOPE");
  assert.deepEqual(r.steps.map((s) => `${s.id}:${s.ok}`), ["auth:true", "project:false"]);
});

test("cases and suites map to records", () => {
  const paths = suitePaths([{ id: 1, title: "Вход" }, { id: 2, title: "Пароль", parent_id: 1, description: "Правила пароля" }]);
  const c = toCase("https://api.qase.io", "DEMO", {
    id: 7, title: "Блокировка", priority: 1, status: 0, suite_id: 2, preconditions: "Есть пользователь",
    steps: [{ position: 1, action: "Ввести пароль 3 раза", expected_result: "Блокировка на 10 минут" }],
  }, paths);
  assert.equal(c.id, "qase:DEMO-7");
  assert.deepEqual(c.suites, ["DEMO / Вход / Пароль"]);
  assert.equal(c.priority, 1);
  assert.equal(c.state, "Actual");
  assert.equal(c.steps[0].action, "Предусловие: Есть пользователь");
  assert.equal(c.steps[1].expected, "Блокировка на 10 минут");
  assert.equal(c.url, "https://app.qase.io/case/DEMO-7");
  const d = suiteDoc("https://api.qase.io", "DEMO", { id: 2, title: "Пароль", parent_id: 1, description: "Правила пароля" }, paths);
  assert.equal(d?.path, "/Вход/Пароль");
  assert.equal(suiteDoc("https://api.qase.io", "DEMO", { id: 1, title: "Вход" }, paths), null);
});
