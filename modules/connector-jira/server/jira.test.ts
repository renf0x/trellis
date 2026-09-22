import { test } from "node:test";
import assert from "node:assert/strict";
import { JiraClient, normalizeBaseUrl, searchAll, stepsFromDescription, testConnection, wikiToMarkdown } from "./jira.ts";
import { toCase, toDoc } from "./index.ts";

test("normalizeBaseUrl handles site names, browse links and server context paths", () => {
  assert.equal(normalizeBaseUrl("acme"), "https://acme.atlassian.net");
  assert.equal(normalizeBaseUrl("https://acme.atlassian.net/browse/QA-1"), "https://acme.atlassian.net");
  assert.equal(normalizeBaseUrl("jira.company.ru/jira/browse/QA-1"), "https://jira.company.ru/jira");
  assert.equal(normalizeBaseUrl("https://jira.company.ru/"), "https://jira.company.ru");
});

test("wikiToMarkdown converts the common markup", () => {
  const md = wikiToMarkdown("h2. Вход\n# первый\n# второй\n* пункт *жирно*\n||Поле||Значение||\n|a|b|\n{code:js}let a = *b*;{code}\nсм. [доку|https://x.ru]");
  assert.match(md, /^## Вход/m);
  assert.match(md, /^1\. первый$/m);
  assert.match(md, /^- пункт \*\*жирно\*\*$/m);
  assert.match(md, /^\| Поле \| Значение \|$/m);
  assert.match(md, /```js\nlet a = \*b\*;\n```/);
  assert.match(md, /\[доку\]\(https:\/\/x\.ru\)/);
});

test("stepsFromDescription reads tables and numbered lists", () => {
  assert.deepEqual(stepsFromDescription("||#||Шаг||Ожидается||\n|1|Открыть вход|Форма видна|\n|2|Ввести пароль 3 раза|Блокировка|"), [
    { kind: "step", action: "Открыть вход", expected: "Форма видна" },
    { kind: "step", action: "Ввести пароль 3 раза", expected: "Блокировка" },
  ]);
  assert.deepEqual(stepsFromDescription("Предусловие\n# Открыть вход\nОжидаемый результат: форма видна\n# Нажать войти"), [
    { kind: "step", action: "Открыть вход", expected: "форма видна" },
    { kind: "step", action: "Нажать войти", expected: "" },
  ]);
});

function fake(routes: Record<string, (u: URL) => unknown>, calls: string[] = []): typeof fetch {
  return (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(`${u.pathname}${u.search}|${(init?.headers as Record<string, string>)?.Authorization ?? ""}`);
    const key = Object.keys(routes).find((k) => u.pathname.endsWith(k));
    if (!key) return new Response(JSON.stringify({ errorMessages: ["nope"] }), { status: 404 });
    const body = routes[key](u);
    if (body instanceof Response) return body;
    return Response.json(body);
  }) as typeof fetch;
}

test("Cloud: Basic email:token, /search/jql paging with nextPageToken", async () => {
  const calls: string[] = [];
  const f = fake({
    "/search/jql": (u) => u.searchParams.get("nextPageToken")
      ? { issues: [{ id: "2", key: "QA-2", fields: { summary: "b" } }] }
      : { issues: [{ id: "1", key: "QA-1", fields: { summary: "a" } }], nextPageToken: "t2" },
  }, calls);
  const c = new JiraClient({ baseUrl: "https://acme.atlassian.net", email: "me@x.ru" }, "tok", f);
  const all = await searchAll(c, "project = QA");
  assert.deepEqual(all.map((i) => i.key), ["QA-1", "QA-2"]);
  assert.ok(calls[0].endsWith(`|Basic ${Buffer.from("me@x.ru:tok").toString("base64")}`));
});

test("Server: Bearer PAT, /search with startAt; checks report each step", async () => {
  const calls: string[] = [];
  const f = fake({
    "/serverInfo": () => ({ serverTitle: "Jira", deploymentType: "Server", version: "9.12" }),
    "/myself": () => ({ displayName: "Тестер" }),
    "/project/QA": () => ({ key: "QA", name: "Качество" }),
    "/search": (u) => u.searchParams.get("jql")!.includes("bad")
      ? new Response(JSON.stringify({ errorMessages: ["Field 'bad' does not exist"] }), { status: 400 })
      : { issues: [{ id: "1", key: "QA-1", fields: {} }], total: 1 },
  }, calls);
  const c = new JiraClient({ baseUrl: "https://jira.company.ru" }, "pat", f);
  const r = await testConnection(c, "QA", { docs: "project = QA", cases: "bad = 1" });
  assert.equal(r.ok, false);
  assert.deepEqual(r.steps.map((s) => `${s.id}:${s.ok}`), ["server:true", "auth:true", "project:true", "docs:true", "cases:false"]);
  assert.match(r.steps[4].message, /does not exist/);
  assert.ok(calls.some((x) => x.endsWith("|Bearer pat")));
});

test("401 stops the check after the login step", async () => {
  const f = fake({
    "/serverInfo": () => ({ version: "1" }),
    "/myself": () => new Response("", { status: 401 }),
  });
  const r = await testConnection(new JiraClient({ baseUrl: "https://jira.company.ru" }, "bad", f), "QA", { docs: "x", cases: "" });
  assert.deepEqual(r.steps.map((s) => s.id), ["server", "auth"]);
  assert.match(r.steps[1].message, /401/);
});

test("issues map to docs and cases", () => {
  const i = {
    id: "1", key: "QA-7",
    fields: {
      summary: "Блокировка", description: "# Ввести пароль 3 раза\nОжидается: блокировка", status: { name: "Готово" },
      issuetype: { name: "Test" }, priority: { name: "High", id: "2" }, components: [{ name: "Вход" }], project: { key: "QA", name: "Q" },
    },
  };
  const c = toCase("https://j.ru", i);
  assert.equal(c.id, "jira:QA-7");
  assert.deepEqual(c.suites, ["QA / Вход"]);
  assert.equal(c.priority, 2);
  assert.equal(c.steps[0].expected, "блокировка");
  assert.equal(c.url, "https://j.ru/browse/QA-7");
  const d = toDoc("https://j.ru", i);
  assert.equal(d.container, "QA · Test");
  assert.match(d.content, /Готово/);
});
