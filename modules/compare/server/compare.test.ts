import { test } from "node:test";
import assert from "node:assert/strict";
import type { DocRecord, ModuleLlm, TestCaseRecord } from "@trellis/core";
import { judgeWithJev, parseChatVerdict } from "./engines.ts";
import { pairUp, terms } from "./pairing.ts";

const doc = (id: string, title: string, content: string): DocRecord => ({ id, source: "t", container: "W", path: `/${title}`, title, content });
const kase = (id: string, title: string, action: string, expected: string): TestCaseRecord => ({
  id, source: "t", externalId: id, title, state: "Ready", suites: ["P / S"], steps: [{ kind: "step", action, expected }],
});

test("terms stem Russian and English and drop stop words", () => {
  assert.deepEqual(terms("Блокировка аккаунта после неудачных попыток входа"), ["блокир", "аккаун", "неудач", "попыто", "входа"]);
  assert.deepEqual(terms("The login and password"), ["login", "passwo"]);
});

test("pairUp links cases to the closest doc and reports orphans both ways", () => {
  const docs = [
    doc("d1", "Вход", "Вход по email и паролю. После 5 неудачных попыток входа аккаунт блокируется на 15 минут."),
    doc("d2", "Корзина", "Товар добавляется в корзину кнопкой. Корзина хранит товары 7 дней."),
    doc("d3", "Отчёты", "Экспорт отчётов в PDF и Excel для бухгалтерии."),
  ];
  const cases = [
    kase("c1", "Блокировка после неудачных попыток входа", "Ввести неверный пароль 3 раза", "Аккаунт блокируется на 10 минут"),
    kase("c2", "Добавление товара в корзину", "Нажать кнопку добавить в корзину", "Товар в корзине"),
    kase("c3", "Push-уведомления", "Включить уведомления на телефоне", "Приходит пуш"),
  ];
  const p = pairUp(docs, cases, { perCase: 1 });
  assert.deepEqual(p.pairs.map((x) => `${x.caseId}-${x.docId}`).sort(), ["c1-d1", "c2-d2"]);
  assert.deepEqual(p.orphanCases, ["c3"]);
  assert.deepEqual(p.uncoveredDocs, ["d3"]);
});

test("parseChatVerdict reads fenced JSON and clamps confidence", () => {
  const v = parseChatVerdict('Вот ответ:\n```json\n{"relation":"contradicts","actuality":"outdated","confidence":1.4,' +
    '"explanation":"5 попыток против 3","issues":[{"summary":"Число попыток","suggestion":"3 → 5"},{"summary":""}]}\n```');
  assert.equal(v.relation, "contradicts");
  assert.equal(v.confidence, 1);
  assert.equal(v.issues.length, 1);
  assert.throws(() => parseChatVerdict('{"relation":"maybe"}'), /relation/);
});

function fakeLlm(confidence: number, choice: string): ModuleLlm & { chats: number } {
  const llm = {
    chats: 0,
    chatModel: async () => "m",
    analysis: async () => ({ jev: { enabled: true, model: "jev", threshold: 0.7 } }),
    decide: async () => ({
      model: "jev-1",
      usage: { inputTokens: 500, outputTokens: 70, costUsd: 0.00002 },
      answers: {
        relation: { type: "choice" as const, choice, probabilities: { [choice]: confidence }, confidence },
        actuality: { type: "score" as const, score: 1.8, legend: {}, probabilities: { 0: 0, 1: 0.2, 2: 0.8 }, confidence: 0.6 },
      },
    }),
    complete: async () => {
      llm.chats++;
      return { text: '{"relation":"partial","actuality":"partial","confidence":0.8,"explanation":"x","issues":[]}', model: "m",
        usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } };
    },
  };
  return llm;
}

test("judgeWithJev: confident & fine → no chat call; problem → chat explains; unsure → chat decides", async () => {
  const d = doc("d", "Вход", "текст");
  const c = kase("c", "Вход", "a", "b");
  const ok = fakeLlm(0.9, "consistent");
  const v1 = await judgeWithJev(ok, d, c, { threshold: 0.7, chat: true });
  assert.equal(v1.engine, "jev");
  assert.equal(v1.actuality, "up_to_date");
  assert.equal(ok.chats, 0);

  const bad = fakeLlm(0.95, "contradicts");
  const v2 = await judgeWithJev(bad, d, c, { threshold: 0.7, chat: true });
  assert.equal(v2.relation, "contradicts");
  assert.equal(v2.explanation, "x");
  assert.equal(bad.chats, 1);

  const unsure = fakeLlm(0.4, "contradicts");
  const v3 = await judgeWithJev(unsure, d, c, { threshold: 0.7, chat: true });
  assert.equal(v3.engine, "jev+chat");
  assert.equal(v3.relation, "partial");
  assert.ok(Math.abs(v3.costUsd - 0.00102) < 1e-9);

  const v4 = await judgeWithJev(fakeLlm(0.4, "contradicts"), d, c, { threshold: 0.7, chat: false });
  assert.equal(v4.engine, "jev");
});
