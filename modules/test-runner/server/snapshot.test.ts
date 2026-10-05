import { test } from "node:test";
import assert from "node:assert/strict";
import type { ModuleLlm } from "@trellis/core";
import { formatSnapshot, pageVerdict, type Snapshot } from "./snapshot.ts";

const snap: Snapshot = {
  url: "https://shop.test/login",
  title: "Вход",
  elements: [
    { ref: 1, tag: "input", type: "email", role: "", label: "Email", value: "qa@shop.test", state: "" },
    { ref: 2, tag: "input", type: "password", role: "", label: "Пароль", value: "***", state: "" },
    { ref: 3, tag: "button", type: "submit", role: "", label: "Войти", value: "", state: "disabled" },
  ],
  text: "Вход в магазин\n" + "x".repeat(500),
  dialogs: ["alert «Сессия истекла» — принято"],
};

test("formatSnapshot lists numbered elements, masks nothing new and cuts long text", () => {
  const s = formatSnapshot(snap, 100);
  assert.match(s, /\[1\] input:email «Email» = «qa@shop.test»/);
  assert.match(s, /\[2\] input:password «Пароль» = «\*\*\*»/);
  assert.match(s, /\[3\] button «Войти» \(disabled\)/);
  assert.match(s, /Диалоги: alert/);
  assert.match(s, /текст обрезан/);
});

test("pageVerdict asks Jev one choice question about the page", async () => {
  let state: any;
  const llm = {
    decide: async (st: unknown) => {
      state = st;
      return { model: "jev", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, answers: { verdict: { type: "choice", choice: "mismatch", probabilities: {}, confidence: 0.92 } } };
    },
  } as unknown as ModuleLlm;
  const v = await pageVerdict(llm, "Открыт личный кабинет", snap);
  assert.deepEqual(v, { choice: "mismatch", confidence: 0.92 });
  assert.equal(state.expected_result, "Открыт личный кабинет");
  assert.equal(state.page.url, snap.url);
});

test("formatSnapshot shows the emulated screen, sideways overflow and console counts", () => {
  const s = formatSnapshot({
    ...snap, screen: "360×800, мобильная версия", notes: ["открылась новая вкладка, дальше действия в ней"],
    layout: { width: 360, overflow: 140, wide: ["table.prices (правый край 500 px)"] },
    console: { errors: 2, warnings: 0, failed: 1 },
  }, 100);
  assert.match(s, /Экран: 360×800, мобильная версия/);
  assert.match(s, /шире экрана на 140 px \(ширина 360 px\).*table\.prices/);
  assert.match(s, /Консоль: ошибок 2, предупреждений 0, неудачных запросов 1/);
  assert.match(s, /Вкладки: открылась новая вкладка/);
  const plain = formatSnapshot({ ...snap, layout: { width: 1280, overflow: 0, wide: [] }, console: { errors: 0, warnings: 0, failed: 0 } }, 100);
  assert.doesNotMatch(plain, /Экран|Вёрстка|Консоль/);
});
