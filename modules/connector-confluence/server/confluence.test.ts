import { test } from "node:test";
import assert from "node:assert/strict";
import { ConfluenceClient, normalizeBaseUrl, pagePaths, spacePages, storageToMarkdown, testConnection } from "./confluence.ts";
import { toDoc } from "./index.ts";

test("normalizeBaseUrl: cloud gets /wiki, server keeps its context path", () => {
  assert.equal(normalizeBaseUrl("mysite"), "https://mysite.atlassian.net/wiki");
  assert.equal(normalizeBaseUrl("https://mysite.atlassian.net/wiki/spaces/QA/pages/1/X"), "https://mysite.atlassian.net/wiki");
  assert.equal(normalizeBaseUrl("wiki.company.ru/confluence/display/QA/Home"), "https://wiki.company.ru/confluence");
});

test("storage format → markdown", () => {
  const md = storageToMarkdown(
    `<h2>Вход</h2><p>Пароль <strong>не короче</strong> 8&nbsp;символов.</p>` +
    `<ul><li>Раз<ul><li>Вложенный</li></ul></li><li>Два</li></ul>` +
    `<table><tbody><tr><th>Поле</th><th>Правило</th></tr><tr><td>Логин</td><td>email</td></tr></tbody></table>` +
    `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">json</ac:parameter><ac:plain-text-body><![CDATA[{"a":1}]]></ac:plain-text-body></ac:structured-macro>` +
    `<p>См. <ac:link><ri:page ri:content-title="Регистрация" /></ac:link></p>`);
  assert.match(md, /^## Вход/);
  assert.match(md, /Пароль \*\*не короче\*\* 8 символов\./);
  assert.match(md, /- Раз\n\s+- Вложенный\n- Два/);
  assert.match(md, /\| Поле \| Правило \|\n\| --- \| --- \|\n\| Логин \| email \|/);
  assert.match(md, /```json\n\{"a":1\}\n```/);
  assert.match(md, /См\. «Регистрация»/);
});

function fake(routes: Record<string, (u: URL) => unknown>, calls: string[] = []): typeof fetch {
  return (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    calls.push(`${u.pathname}${u.search}|${(init?.headers as Record<string, string>)?.Authorization ?? ""}`);
    const key = Object.keys(routes).find((k) => u.pathname === k);
    if (!key) return new Response(JSON.stringify({ message: "No space" }), { status: 404 });
    const r = routes[key](u);
    return r instanceof Response ? r : Response.json(r);
  }) as typeof fetch;
}

test("cloud: v2 pages follow the cursor link, Basic auth with email", async () => {
  const calls: string[] = [];
  const c = new ConfluenceClient("https://s.atlassian.net/wiki", "a@b.c", "tok", fake({
    "/wiki/api/v2/spaces/9/pages": (u) => u.searchParams.get("cursor")
      ? { results: [{ id: "2", title: "Child", parentId: "1", body: { storage: { value: "<p>b</p>" } } }] }
      : { results: [{ id: "1", title: "Root", body: { storage: { value: "<p>a</p>" } }, _links: { webui: "/spaces/QA/pages/1" } }], _links: { next: "/wiki/api/v2/spaces/9/pages?cursor=xyz" } },
  }, calls));
  const pages = await spacePages(c, { id: "9", key: "QA", name: "QA" });
  assert.deepEqual(pages.map((p) => p.id), ["1", "2"]);
  assert.equal(calls.length, 2);
  assert.ok(calls[0].endsWith(`|Basic ${Buffer.from("a@b.c:tok").toString("base64")}`));
  const paths = pagePaths(pages);
  assert.equal(paths.get("2"), "/Root/Child");
  const d = toDoc("https://s.atlassian.net/wiki", { key: "QA", name: "Тестирование" }, pages[0], paths);
  assert.equal(d.id, "confluence:QA:1");
  assert.equal(d.url, "https://s.atlassian.net/wiki/spaces/QA/pages/1");
  assert.equal(d.content, "a");
});

test("server: v1 content pages with start/limit, Bearer token, parent from ancestors", async () => {
  const calls: string[] = [];
  const c = new ConfluenceClient("https://wiki.local", undefined, "pat", fake({
    "/rest/api/content": (u) => Number(u.searchParams.get("start")) === 0
      ? { limit: 2, results: [{ id: "1", title: "A" }, { id: "2", title: "B", ancestors: [{ id: "1" }] }] }
      : { limit: 2, results: [{ id: "3", title: "C", ancestors: [{ id: "1" }, { id: "2" }] }] },
  }, calls));
  const pages = await spacePages(c, { key: "QA", name: "QA" });
  assert.equal(pages.length, 3);
  assert.ok(calls[0].endsWith("|Bearer pat"));
  assert.match(calls[1], /start=2/);
  assert.equal(pagePaths(pages).get("3"), "/A/B/C");
});

test("check: rejected token stops; unknown space is reported", async () => {
  const bad = await testConnection(new ConfluenceClient("https://wiki.local", undefined, "x", fake({
    "/rest/api/user/current": () => new Response("{}", { status: 401 }),
  })), ["QA"]);
  assert.deepEqual(bad.steps.map((s) => `${s.id}:${s.ok}`), ["auth:false"]);

  const r = await testConnection(new ConfluenceClient("https://wiki.local", undefined, "t", fake({
    "/rest/api/user/current": () => ({ displayName: "Tester", type: "known" }),
    "/rest/api/space/QA": () => ({ key: "QA", name: "Тестирование" }),
  })), ["QA", "NOPE"]);
  assert.deepEqual(r.steps.map((s) => `${s.id}:${s.ok}`), ["auth:true", "space:QA:true", "space:NOPE:false"]);
  assert.equal(r.ok, false);
});
