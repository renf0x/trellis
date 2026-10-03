import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocRecord, ServerModuleContext, SourceSnapshot } from "@trellis/core";
import { register } from "./index.ts";

type Handler = (req: { params: Record<string, string>; query: Record<string, string | undefined>; body: unknown }) => Promise<unknown>;
interface Remote { title: string; body: string; version: number }

function setup(remote: Remote) {
  const routes = new Map<string, Handler>();
  const files = new Map<string, unknown>([["settings", { baseUrl: "https://wiki.corp.local", email: "", spaces: [] }]]);
  let snap: SourceSnapshot = {
    source: "confluence", title: "Confluence", syncedAt: "2026-01-01", cases: [],
    docs: [{ id: "confluence:QA:42", source: "confluence", externalId: "42", container: "QA", path: "/Вход", title: remote.title, content: "" } as DocRecord],
  };
  const ctx = {
    route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h),
    files: { read: async (n: string) => files.get(n) ?? null, write: async (n: string, v: unknown) => void files.set(n, structuredClone(v)) },
    secrets: { get: async () => ({ token: "test-token" }), set: async () => {} },
    data: {
      sources: async () => [{ source: "confluence", title: snap.title, syncedAt: snap.syncedAt, docs: 1, cases: 0 }],
      docs: async () => snap.docs,
      cases: async () => snap.cases,
      replace: async (s: SourceSnapshot) => void (snap = s),
    },
    log: () => {},
  } as unknown as ServerModuleContext;
  const puts: { version: { number: number; message: string }; title: string; body: { storage: { value: string } } }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: URL | string, init?: RequestInit) => {
    const u = new URL(String(input));
    if (u.pathname !== "/rest/api/content/42") return new Response("{}", { status: 404 });
    if (init?.method === "PUT") {
      const b = JSON.parse(String(init.body));
      if (b.version.number !== remote.version + 1) return new Response(JSON.stringify({ message: "version conflict" }), { status: 409 });
      puts.push(b);
      Object.assign(remote, { title: b.title, body: b.body.storage.value, version: b.version.number });
      return new Response("", { status: 200 });
    }
    return Response.json({ id: "42", title: remote.title, body: { storage: { value: remote.body } }, version: { number: remote.version } });
  }) as typeof fetch;
  register(ctx);
  const call = (m: string, p: string, params: Record<string, string> = {}, body?: unknown) => routes.get(`${m} ${p}`)!({ params, query: {}, body });
  return { call, puts, snap: () => snap, restore: () => void (globalThis.fetch = realFetch) };
}

test("plain-text find/replace is matched against the escaped storage body and saved as version+1", async () => {
  const remote = { title: "Вход", body: "<p>Пароль &gt; 8 символов &amp; цифры</p><p>Блокировка после 5 попыток</p>", version: 3 };
  const t = setup(remote);
  try {
    const p = (await t.call("POST", "/changes", {}, {
      target: "doc", id: "confluence:QA:42", reason: "Требование 2.1 уточнено", find: "Пароль > 8 символов & цифры", replace: "Пароль ≥ 10 символов & цифры",
    })) as { pid: string; before: Record<string, string>; after: Record<string, string> };
    assert.match(p.before.text, /Пароль > 8/);
    assert.match(p.after.text, /Пароль ≥ 10/);
    assert.equal(t.puts.length, 0);
    await t.call("POST", "/changes/:pid/apply", { pid: p.pid }, { confirm: true });
    assert.equal(t.puts.length, 1);
    assert.equal(t.puts[0].version.number, 4);
    assert.equal(t.puts[0].version.message, "Trellis: Требование 2.1 уточнено");
    assert.equal(t.puts[0].body.storage.value, "<p>Пароль ≥ 10 символов &amp; цифры</p><p>Блокировка после 5 попыток</p>");
    assert.match(t.snap().docs[0].content, /Пароль ≥ 10/);
  } finally {
    t.restore();
  }
});

test("a page edited in Confluence after the proposal is not overwritten", async () => {
  const remote = { title: "Вход", body: "<p>Блокировка после 5 попыток</p>", version: 3 };
  const t = setup(remote);
  try {
    const p = (await t.call("POST", "/changes", {}, { target: "doc", id: "confluence:QA:42", reason: "r", find: "5 попыток", replace: "3 попыток" })) as { pid: string };
    Object.assign(remote, { body: "<p>Блокировка после 5 попыток за 10 минут</p>", version: 4 });
    await assert.rejects(t.call("POST", "/changes/:pid/apply", { pid: p.pid }, { confirm: true }), /изменил|конфликт|обновил/i);
    assert.equal(t.puts.length, 0);
    await assert.rejects(t.call("POST", "/changes", {}, { target: "doc", id: "confluence:QA:42", reason: "r", find: "нет такого", replace: "x" }), /не найден/);
  } finally {
    t.restore();
  }
});
