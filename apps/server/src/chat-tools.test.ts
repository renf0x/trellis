import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ChatTool } from "@trellis/core";
import { findToolCalls, idleGuard, nudgeFor, withTools } from "./chat-tools.ts";

test("findToolCalls takes only registered tools and leaves trellis-change alone", () => {
  const text = 'Открываю.\n```trellis-browser\n{"action":"open","url":"https://x.ru"}\n```\n```trellis-change\n{}\n```\n```trellis-other\n{}\n```';
  assert.deepEqual(findToolCalls(text, new Set(["browser"])), [{ tool: "browser", raw: '{"action":"open","url":"https://x.ru"}' }]);
});

test("withTools runs the tools, streams short results and feeds details back until the model stops", async () => {
  const seen: ChatMessage[][] = [];
  const replies = [
    'Шаг 1.\n```trellis-browser\n{"action":"open","url":"https://x.ru"}\n```',
    '```trellis-browser\n{"action":"fill","ref":1,"value":"a"}\n```\n```trellis-browser\nне json\n```',
    "Отчёт: всё прошло.",
  ];
  const tool: ChatTool = {
    name: "browser",
    channels: ["work"],
    run: async (input) => ({ ok: true, summary: `сделано ${input.action}`, detail: `СНИМОК ${input.action}` }),
  };
  const out: string[] = [];
  const step = async function* (messages: ChatMessage[]) {
    seen.push(messages);
    yield { type: "text", delta: replies[seen.length - 1] };
    yield { type: "usage" };
  };
  for await (const c of withTools([{ role: "user", content: "пройди" }], new Map([["browser", tool]]), "s1", new AbortController().signal, step)) {
    if (c.type === "text") out.push(c.delta!);
  }
  assert.equal(seen.length, 3);
  const text = out.join("");
  assert.match(text, /```trellis-result\n\{"tool":"browser","ok":true,"summary":"сделано open"\}/);
  assert.match(text, /"ok":false,"summary":"Блок не разобран/);
  assert.ok(text.endsWith("Отчёт: всё прошло."));
  // Third call: the first result shrank to its summary, the newest keeps its snapshot; a bad block is reported.
  const last = seen[2];
  assert.equal(last.length, 5);
  assert.doesNotMatch(last[2].content, /СНИМОК open/);
  assert.match(last[2].content, /сделано open/);
  assert.match(last[4].content, /СНИМОК fill/);
  assert.match(last[4].content, /НЕ выполнено: Блок не разобран/);
});

test("withTools without tools is a plain pass-through", async () => {
  let calls = 0;
  const step = async function* () {
    calls++;
    yield { type: "text", delta: '```trellis-browser\n{"action":"open"}\n```' };
  };
  for await (const _ of withTools([{ role: "user", content: "x" }], new Map(), "s", new AbortController().signal, step)) { /* drain */ }
  assert.equal(calls, 1);
});

const browser: ChatTool = { name: "browser", channels: ["work"], run: async () => ({ ok: true, summary: "ok" }) };
const only = new Map([["browser", browser]]);

test("nudgeFor: broken blocks and mid-run stops get a reminder; questions and reports do not", () => {
  assert.match(nudgeFor('Открываю:\n```json\n{"action":"open","url":"https://x.ru"}\n```', only, false)!, /```trellis-browser/);
  assert.match(nudgeFor('```trellis-browser\n{"action":"click","ref":2}', only, true)!, /Повтори последнее действие/);
  assert.match(nudgeFor("Шаг 2 выполнен. Перехожу к шагу 3.", only, true)!, /остановился без блока/);
  assert.match(nudgeFor("Сейчас открою сайт и начну.", only, false)!, /остановился без блока/);
  assert.equal(nudgeFor("Для входа нужен логин и пароль. Пришлёте?", only, true), null);
  assert.equal(nudgeFor("| № | действие |\n|---|---|\n| 1 | открыть |\nОбщий статус: пройден.", only, true), null);
  assert.equal(nudgeFor("Привет! Чем помочь.", only, false), null);
});

test("withTools reminds a stalled model to go on, at most MAX_NUDGES times in a row", async () => {
  const replies = [
    '```trellis-browser\n{"action":"open","url":"https://x.ru"}\n```',
    "Открыл. Перехожу к шагу 2.",
    '```trellis-browser\n{"action":"click","ref":1}\n```',
    "Продолжаю.",
    "Продолжаю.",
    "Продолжаю.",
  ];
  const seen: ChatMessage[][] = [];
  const step = async function* (messages: ChatMessage[]) {
    seen.push(messages);
    yield { type: "text", delta: replies[seen.length - 1] };
  };
  let out = "";
  for await (const c of withTools([{ role: "user", content: "пройди" }], only, "s2", new AbortController().signal, step)) {
    if (c.type === "text") out += c.delta;
  }
  // open, stall → nudge, click, stall → nudge, stall → nudge, stall → give up.
  assert.equal(seen.length, 6);
  assert.match(seen[2].at(-1)!.content, /остановился без блока/);
  assert.doesNotMatch(out, /остановился без блока/);
});

test("idleGuard cuts off a stream that goes silent", async () => {
  const silent = async function* (signal: AbortSignal) {
    yield "a";
    await new Promise((_, fail) => signal.addEventListener("abort", () => fail(new Error("aborted"))));
  };
  const got: string[] = [];
  await assert.rejects(async () => { for await (const c of idleGuard(30, silent)) got.push(c); }, /Модель не отвечает/);
  assert.deepEqual(got, ["a"]);
});
