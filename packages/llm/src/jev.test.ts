import { test } from "node:test";
import assert from "node:assert/strict";
import { jevDecide } from "./jev.ts";

// Shape recorded from a live call on 2026-09-22.
const LIVE = {
  model: "typesafe/jev-1.13-20260917",
  answers: {
    related: { type: "noul", noul: 0.1 },
    consistency: { type: "choice", choice: "contradicts", probabilities: { consistent: 0, unrelated: 0, contradicts: 1 }, confidence: 1 },
    actuality: {
      type: "score", score: 0.58, legend: { 0: "outdated", 1: "partially outdated", 2: "up to date" },
      probabilities: { 0: 0.42, 1: 0.58, 2: 0 }, confidence: 0.36,
    },
  },
  usage: { input_tokens: 523, output_tokens: 78, cost: 0.000021966 },
  id: "gen-dec-1",
  provider: "TypeSafe",
};

const questions = {
  related: { type: "noul" as const, instructions: "?" },
  consistency: { type: "choice" as const, instructions: "?", criteria: { consistent: "", contradicts: "", unrelated: "" } },
  actuality: { type: "score" as const, instructions: "?", criteria: ["outdated", "partially outdated", "up to date"] },
};

test("jevDecide parses a live-shaped answer and sends the request body", async () => {
  let sent: any;
  const fake = (async (_u: unknown, init?: RequestInit) => {
    sent = JSON.parse(String(init?.body));
    return Response.json(LIVE);
  }) as typeof fetch;
  const r = await jevDecide({ apiKey: "k", model: "~typesafe/jev-latest", state: { a: 1 }, questions, fetch: fake });
  assert.equal(sent.model, "~typesafe/jev-latest");
  assert.deepEqual(sent.state, { a: 1 });
  assert.equal(r.model, "typesafe/jev-1.13-20260917");
  assert.deepEqual(r.answers.related, { type: "noul", noul: 0.1 });
  const c = r.answers.consistency;
  assert.ok(c.type === "choice" && c.choice === "contradicts" && c.confidence === 1);
  const s = r.answers.actuality;
  assert.ok(s.type === "score" && s.score === 0.58 && s.legend["2"] === "up to date");
  assert.equal(r.usage.inputTokens, 523);
  assert.equal(r.usage.costUsd, 0.000021966);
});

test("jevDecide explains 402 and rejects a missing answer", async () => {
  const pay = (async () => new Response(JSON.stringify({ error: { message: "no credits" } }), { status: 402 })) as typeof fetch;
  await assert.rejects(jevDecide({ apiKey: "k", model: "m", state: "s", questions, fetch: pay }), /не хватает средств/);
  const partial = (async () => Response.json({ ...LIVE, answers: { related: LIVE.answers.related } })) as typeof fetch;
  await assert.rejects(jevDecide({ apiKey: "k", model: "m", state: "s", questions, fetch: partial }), /consistency/);
});

const CLOUDFLARE = '<!DOCTYPE html>\n<!--[if lt IE 7]> <html class="no-js ie6 oldie" lang="en-US"> <![endif]-->\n' +
  "<html><head><title>Attention Required! | Cloudflare</title></head><body>blocked</body></html>";

test("jevDecide retries a Cloudflare page and a 429, then answers", async () => {
  let calls = 0;
  const flaky = (async () => {
    calls++;
    if (calls === 1) return new Response(CLOUDFLARE, { status: 403, headers: { "Content-Type": "text/html" } });
    if (calls === 2) return new Response("{}", { status: 429 });
    return new Response(JSON.stringify(LIVE), { status: 200 });
  }) as typeof fetch;
  const r = await jevDecide({ apiKey: "k", model: "m", state: {}, questions, fetch: flaky, retryDelaysMs: [1, 1, 1] });
  assert.equal(calls, 3);
  assert.equal(r.answers.related.type, "noul");
});

test("jevDecide shows a short message instead of the Cloudflare page; a JSON 403 is not retried", async () => {
  let calls = 0;
  const blocked = (async () => (calls++, new Response(CLOUDFLARE, { status: 403 }))) as typeof fetch;
  await assert.rejects(jevDecide({ apiKey: "k", model: "m", state: {}, questions, fetch: blocked, retryDelaysMs: [1, 1] }), (e: Error) => {
    assert.match(e.message, /^Jev: 403, вместо ответа пришла страница Cloudflare \(«Attention Required! \| Cloudflare»\)/);
    assert.doesNotMatch(e.message, /<html|DOCTYPE/);
    return true;
  });
  assert.equal(calls, 3);

  calls = 0;
  const denied = (async () => (calls++, new Response(JSON.stringify({ error: { message: "key disabled" } }), { status: 403 }))) as typeof fetch;
  await assert.rejects(jevDecide({ apiKey: "k", model: "m", state: {}, questions, fetch: denied, retryDelaysMs: [1, 1] }), /Jev: 403 key disabled/);
  assert.equal(calls, 1);
});

test("jevDecide retries a dropped connection", async () => {
  let calls = 0;
  const drop = (async () => {
    if (++calls === 1) throw new TypeError("fetch failed");
    return new Response(JSON.stringify(LIVE), { status: 200 });
  }) as typeof fetch;
  await jevDecide({ apiKey: "k", model: "m", state: {}, questions, fetch: drop, retryDelaysMs: [1] });
  assert.equal(calls, 2);
});
