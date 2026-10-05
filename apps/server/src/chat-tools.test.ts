import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatMessage, ChatTool } from "@trellis/core";
import { findToolCalls, withTools } from "./chat-tools.ts";

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
