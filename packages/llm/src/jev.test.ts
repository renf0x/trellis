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
