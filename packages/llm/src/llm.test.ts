import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatChunk } from "@trellis/core";
import { buildAuthorizeUrl, chatGptChat, createPkce, tokensFromResponse } from "./chatgpt.ts";
import { Ledger, summarize } from "./ledger.ts";
import { openRouterChat } from "./openrouter.ts";

function sseFetch(chunks: string[], status = 200, capture?: { body?: any; headers?: any }): typeof fetch {
  return (async (_url: unknown, init?: RequestInit) => {
    if (capture) {
      capture.body = JSON.parse(String(init?.body));
      capture.headers = init?.headers;
    }
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const s of chunks) c.enqueue(enc.encode(s));
        c.close();
      },
    });
    return new Response(body, { status });
  }) as typeof fetch;
}

async function collect(it: AsyncIterable<ChatChunk>) {
  const out: ChatChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
}

test("openrouter: streamed text split across chunks, usage with cost", async () => {
  const cap: { body?: any } = {};
  const chunks = await collect(openRouterChat({
    apiKey: "k",
    model: "some/model:free",
    messages: [{ role: "user", content: "привет" }],
    fetch: sseFetch([
      ": OPENROUTER PROCESSING\n\n",
      'data: {"choices":[{"delta":{"content":"При"}}]}\n\ndata: {"choices":[{"del',
      'ta":{"content":"вет"}}]}\r\n\r\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2,"cost":0.0012}}\n\n',
      "data: [DONE]\n\n",
    ], 200, cap),
  }));
  assert.equal(cap.body.model, "some/model:free");
  assert.deepEqual(cap.body.usage, { include: true });
  const text = chunks.flatMap((c) => (c.type === "text" ? [c.delta] : [])).join("");
  assert.equal(text, "Привет");
  assert.deepEqual(chunks.at(-2), { type: "usage", usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.0012 } });
});

test("openrouter: http error is readable", async () => {
  await assert.rejects(
    collect(openRouterChat({ apiKey: "k", model: "x", messages: [], fetch: sseFetch(['{"error":{"message":"No auth"}}'], 401) })),
    /OpenRouter: 401 No auth/,
  );
});

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;

test("openrouter: retries 429 then streams", async () => {
  let calls = 0;
  const ok = sseFetch(['data: {"choices":[{"delta":{"content":"ok"}}]}\n\n', "data: [DONE]\n\n"]);
  const flaky = (async (u: unknown, i?: RequestInit) =>
    ++calls < 3 ? new Response('{"error":{"message":"rate"}}', { status: 429 }) : ok(u as string, i)) as typeof fetch;
  const chunks = await collect(openRouterChat({ apiKey: "k", model: "m:free", messages: [], fetch: flaky, retryDelaysMs: [1, 1, 1] }));
  assert.equal(calls, 3);
  assert.deepEqual(chunks[0], { type: "text", delta: "ok" });
  await assert.rejects(
    collect(openRouterChat({ apiKey: "k", model: "m", messages: [], retryDelaysMs: [1],
      fetch: (async () => new Response("{}", { status: 429 })) as typeof fetch })),
    /429, модель перегружена/,
  );
});

test("chatgpt: tokens decode account id, plan and email from id_token", () => {
  const t = tokensFromResponse({
    access_token: "a",
    refresh_token: "r",
    expires_in: 60,
    id_token: jwt({ email: "u@example.com", "https://api.openai.com/auth": { chatgpt_account_id: "acc", chatgpt_plan_type: "plus" } }),
  });
  assert.equal(t.accountId, "acc");
  assert.equal(t.plan, "plus");
  assert.equal(t.email, "u@example.com");
  const url = new URL(buildAuthorizeUrl(createPkce().challenge, "st"));
  assert.equal(url.searchParams.get("redirect_uri"), "http://localhost:1455/auth/callback");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("chatgpt: responses stream maps to text and subscription usage", async () => {
  const cap: { body?: any; headers?: any } = {};
  const chunks = await collect(chatGptChat({
    tokens: { accessToken: "a", refreshToken: "r", expiresAt: 0, accountId: "acc" },
    model: "gpt-5.2",
    effort: "low",
    messages: [{ role: "system", content: "Будь краток" }, { role: "user", content: "hi" }],
    fetch: sseFetch([
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hel"}\n\n',
      'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"lo"}\n\n',
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":9,"output_tokens":3}}}\n\n',
    ], 200, cap),
  }));
  assert.equal(cap.body.instructions, "Будь краток");
  assert.equal(cap.body.store, false);
  assert.equal(cap.headers["chatgpt-account-id"], "acc");
  assert.equal(chunks.flatMap((c) => (c.type === "text" ? [c.delta] : [])).join(""), "Hello");
  assert.deepEqual(chunks.at(-2), { type: "usage", usage: { inputTokens: 9, outputTokens: 3, costUsd: 0, subscription: true } });
});

test("ledger keeps free, paid and subscription apart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trellis-ledger-"));
  try {
    const ledger = new Ledger(join(dir, "usage", "ledger.jsonl"));
    const at = new Date().toISOString();
    const u = (i: number, o: number, c = 0) => ({ inputTokens: i, outputTokens: o, costUsd: c });
    await ledger.append({ at, bucket: "main", provider: "openrouter", model: "m:free", tier: "free", usage: u(10, 5) });
    await ledger.append({ at, bucket: "main", provider: "openrouter", model: "m", tier: "paid", usage: u(100, 50, 0.01) });
    await ledger.append({ at, bucket: "dev", provider: "chatgpt", model: "gpt-5.2", tier: "subscription", usage: u(7, 3) });
    const s = summarize(await ledger.read());
    assert.equal(s.tiers.free.inputTokens, 10);
    assert.equal(s.tiers.paid.costUsd, 0.01);
    assert.equal(s.tiers.subscription.requests, 1);
    assert.equal(s.models[0].model, "m");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
