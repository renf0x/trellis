import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecisionQuestion, DocRecord, ModuleLlm, ServerModuleContext, TestCaseRecord } from "@trellis/core";
import { extractRequirements, judgeCaseDoc, judgeCoverage, judgeQuality, parseQuality } from "./stages.ts";
import { register } from "./index.ts";
import { caseDocCandidates, coverageCandidates, docChunks } from "./pairing.ts";

const doc = (id: string, title: string, content: string): DocRecord => ({ id, source: "t", container: "W", path: `/${title}`, title, content });
const kase = (id: string, title: string, action: string, expected: string): TestCaseRecord => ({
  id, source: "t", externalId: id, title, state: "Ready", suites: ["P / S"], steps: [{ kind: "step", action, expected }],
});

const LOGIN = doc("d1", "Вход", [
  "# Вход в систему",
  "Пользователь входит по email и паролю.",
  "- Пароль должен содержать не менее 8 символов",
  "- После 5 неудачных попыток аккаунт блокируется на 15 минут",
  "Система должна показывать сообщение об ошибке при неверном пароле.",
  "```",
  "- must not be extracted from code",
  "```",
  "| Поле | Ограничение |",
  "|---|---|",
  "| Email | не более 254 символов |",
  "System.TypeLoadException: at Common.Utilities.TypesResolver(String)<013>",
  "Красивый и удобный экран.",
].join("\n"));

test("extractRequirements keeps list items, table rows and requirement sentences, skips code, headings and logs", () => {
  assert.deepEqual(extractRequirements(LOGIN).map((r) => r.text), [
    "Пароль должен содержать не менее 8 символов",
    "После 5 неудачных попыток аккаунт блокируется на 15 минут",
    "Система должна показывать сообщение об ошибке при неверном пароле.",
    "Email — не более 254 символов",
  ]);
  assert.equal(extractRequirements(LOGIN, 2).length, 2);
});

test("extractRequirements reads dash and bullet lists, skips lead-ins and keeps them as the section", () => {
  const d = doc("d3", "Форма", [
    "## Регистрация",
    "Форма содержит поля:",
    "– Имя пользователя обязательно для заполнения",
    "• Телефон в формате +7XXXXXXXXXX",
    "",
    "Описание экрана без требований.",
    "— Кнопка «Сохранить» неактивна до заполнения формы",
  ].join("\n"));
  assert.deepEqual(extractRequirements(d), [
    { text: "Имя пользователя обязательно для заполнения", section: "Регистрация › Форма содержит поля" },
    { text: "Телефон в формате +7XXXXXXXXXX", section: "Регистрация › Форма содержит поля" },
    { text: "Кнопка «Сохранить» неактивна до заполнения формы", section: "Регистрация" },
  ]);
});

test("coverageCandidates matches single steps and falls back to cases paired with the document", () => {
  const long = kase("c1", "Профиль", "Открыть профиль", "Профиль открыт");
  long.steps.push(...Array.from({ length: 12 }, (_, i) => ({ kind: "step" as const, action: `Изменить настройку ${i} уведомлений`, expected: `Настройка ${i} сохранена` })),
    { kind: "step", action: "Ввести пароль из 7 символов", expected: "Ошибка: пароль короче 8 символов" });
  const other = kase("c2", "Login form", "Open login page", "Page is shown");
  const [byStep, byPair, none] = coverageCandidates([
    { docId: "d1", text: "Пароль должен содержать не менее 8 символов" },
    { docId: "d1", text: "Аватар загружается в формате PNG" },
    { docId: "d9", text: "Отчёт выгружается в PDF" },
  ], [long, other], [{ docId: "d1", caseId: "c2", similarity: 0.3 }]);
  assert.equal(byStep[0].caseId, "c1");
  assert.ok(byStep.some((x) => x.caseId === "c2")); // the document's paired case is offered too
  assert.deepEqual(byPair, [{ caseId: "c2", similarity: 0 }]);
  assert.deepEqual(none, []);
});

test("parseQuality clamps scores and keeps known criteria", () => {
  const q = parseQuality('```json\n{"scores":{"consistency":1.5,"atomicity":0.2,"verifiability":"x"},"remarks":[{"criterion":"atomicity","summary":"Два требования в одном пункте"},{"criterion":"zzz","summary":"Прочее"},{"summary":""}]}\n```');
  assert.equal(q.scores.consistency, 1);
  assert.equal(q.scores.verifiability, 0.5);
  assert.deepEqual(q.remarks.map((r) => r.criterion), ["atomicity", "other"]);
});

/** Jev answers every question with the given choice/score; the chat model returns `chatText`. */
function fakeLlm(opts: { choice?: Record<string, string>; score?: number; chatText?: string; confidence?: number }): ModuleLlm & { decides: number; chats: number } {
  const llm = {
    decides: 0,
    chats: 0,
    chatModel: async () => "m",
    analysis: async () => ({ jev: { enabled: true, model: "jev", threshold: 0.7 } }),
    decide: async (_s: unknown, qs: Record<string, DecisionQuestion>) => {
      llm.decides++;
      const answers = Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, q.type === "score"
        ? { type: "score" as const, score: opts.score ?? 2, legend: {}, probabilities: {}, confidence: 0.9 }
        : { type: "choice" as const, choice: opts.choice?.[k] ?? Object.keys(q.type === "choice" ? q.criteria : {})[0], probabilities: {}, confidence: opts.confidence ?? 0.9 }]));
      return { model: "jev-1", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.00001 }, answers };
    },
    complete: async () => {
      llm.chats++;
      return { text: opts.chatText ?? "{}", model: "m", usage: { inputTokens: 1, outputTokens: 1, costUsd: 0.001 } };
    },
  };
  return llm as unknown as ModuleLlm & { decides: number; chats: number };
}

test("judgeQuality: good doc → Jev only; weak doc → chat writes remarks", async () => {
  const good = fakeLlm({ score: 2 });
  const v1 = await judgeQuality(good, LOGIN, { engine: "jev", chat: true });
  assert.equal(v1.overall, 1);
  assert.equal(good.chats, 0);

  const weak = fakeLlm({ score: 0, chatText: '{"scores":{},"remarks":[{"criterion":"unambiguity","summary":"«Красивый и удобный» не проверить"}]}' });
  const v2 = await judgeQuality(weak, LOGIN, { engine: "jev", chat: true });
  assert.equal(v2.engine, "jev+chat");
  assert.equal(v2.scores.unambiguity, 0); // Jev's scores stay, the chat only adds text
  assert.equal(v2.remarks[0].criterion, "unambiguity");
});

test("judgeCoverage maps Jev's case pick back to the case id", async () => {
  const cs = [kase("c1", "Длина пароля", "Ввести 7 символов", "Ошибка"), kase("c2", "Блокировка", "5 раз неверный пароль", "Блок на 15 минут")];
  const v = await judgeCoverage(fakeLlm({ choice: { coverage: "covered", case: "case_2" } }), "После 5 неудачных попыток аккаунт блокируется", LOGIN, cs, { engine: "jev" });
  assert.deepEqual([v.status, v.caseId], ["covered", "c2"]);
  const n = await judgeCoverage(fakeLlm({ choice: { coverage: "not_covered", case: "case_1" } }), "x", LOGIN, cs, { engine: "jev" });
  assert.equal(n.caseId, undefined);
  const chat = await judgeCoverage(fakeLlm({ chatText: '{"status":"partial","case":"case_1","confidence":0.7,"comment":"нет проверки 8 символов"}' }), "x", LOGIN, cs, { engine: "chat" });
  assert.deepEqual([chat.status, chat.caseId, chat.comment], ["partial", "c1", "нет проверки 8 символов"]);
});

test("judgeCoverage hands unsure Jev verdicts to the chat model and asks it what a partial cover misses", async () => {
  const cs = [kase("c1", "Длина пароля", "Ввести 7 символов", "Ошибка")];
  const chatText = '{"status":"covered","case":"case_1","confidence":0.9,"comment":"проверено"}';
  const unsure = fakeLlm({ choice: { coverage: "not_covered", case: "none" }, chatText, confidence: 0.4 });
  const u = await judgeCoverage(unsure, "x", LOGIN, cs, { engine: "jev", chat: true, threshold: 0.7 });
  assert.deepEqual([u.status, u.caseId, u.engine, unsure.chats], ["covered", "c1", "jev+chat", 1]);
  const partial = fakeLlm({ choice: { coverage: "partial", case: "case_1" }, chatText });
  const p = await judgeCoverage(partial, "x", LOGIN, cs, { engine: "jev", chat: true, threshold: 0.5, section: "Вход" });
  assert.deepEqual([p.status, p.comment, p.engine], ["partial", "проверено", "jev+chat"]);
  const sure = fakeLlm({ choice: { coverage: "not_covered", case: "none" }, chatText });
  await judgeCoverage(sure, "x", LOGIN, cs, { engine: "jev", chat: true, threshold: 0.5 });
  assert.equal(sure.chats, 0);
});

type Handler = (req: { params: Record<string, string>; query: Record<string, string | undefined>; body: unknown }) => Promise<unknown>;

test("a staged run scores docs, measures coverage, keeps remark statuses and skipped stages", async () => {
  const routes = new Map<string, Handler>();
  const files = new Map<string, unknown>();
  const docs = [LOGIN, doc("d2", "Отчёты", "- Отчёт выгружается в PDF\n- Отчёт выгружается в Excel")];
  const cases = [kase("c1", "Блокировка после неудачных попыток", "Ввести неверный пароль 5 раз", "Аккаунт блокируется на 15 минут")];
  const llm = fakeLlm({ score: 0, choice: { coverage: "covered", case: "case_1", relation: "consistent" },
    chatText: '{"scores":{},"remarks":[{"criterion":"completeness","summary":"Нет сценария восстановления пароля"}]}' });
  register({
    route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h),
    files: { read: async (n: string) => structuredClone(files.get(n) ?? null), write: async (n: string, v: unknown) => void files.set(n, structuredClone(v)) },
    data: { docs: async () => docs, cases: async () => cases },
    llm,
    log: () => {},
  } as unknown as ServerModuleContext);
  const call = (m: string, p: string, o: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) =>
    routes.get(`${m} ${p}`)!({ params: o.params ?? {}, query: o.query ?? {}, body: o.body });
  const finish = async () => {
    for (let i = 0; i < 100; i++) {
      const s = (await call("GET", "/status")) as { run: { running: boolean } };
      if (!s.run.running) return s;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("run did not finish");
  };

  await call("POST", "/run", { body: { engine: "jev", stages: { pairs: false, casedocs: false } } });
  await finish();
  const quality = (await call("GET", "/quality")) as { items: { docId: string; verdict: { overall: number } }[] };
  assert.equal(quality.items.length, 2);
  const cov = (await call("GET", "/coverage")) as { summary: { total: number; covered: number; notCovered: number; percent: number }; docs: { doc: { id: string }; percent: number }[] };
  // The login doc is paired with the lockout case, so Jev checks all its requirements;
  // the reports doc has no related case, so its two are uncovered without a model call.
  assert.deepEqual([cov.summary.total, cov.summary.covered, cov.summary.notCovered, cov.summary.percent], [6, 4, 2, 67]);
  assert.equal(llm.decides, 2 + 4); // two quality calls, four coverage calls
  const skipped = (await call("GET", "/coverage", { query: { status: "not_covered" } })) as { items: { docId: string; reason?: string }[] };
  assert.deepEqual(skipped.items.map((r) => [r.docId, r.reason]), [["d2", "no-candidates"], ["d2", "no-candidates"]]);
  assert.equal(cov.docs[0].doc.id, "d2");
  assert.equal(cov.docs[0].percent, 0);

  const rem = (await call("GET", "/remarks")) as { items: { id: string; status: string }[] };
  assert.equal(rem.items.length, 2); // one per doc, both weak
  await call("POST", "/remarks/:id", { params: { id: rem.items[0].id }, body: { status: "postponed" } });

  // Only pairs this time: quality and coverage stay from the first run, remark status is kept.
  await call("POST", "/run", { body: { engine: "jev", stages: { quality: false, coverage: false } } });
  const s = (await finish()) as unknown as { stageAt: Record<string, string>; coverage: { total: number } };
  assert.ok(s.stageAt.quality && s.stageAt.coverage && s.stageAt.pairs);
  assert.notEqual(s.stageAt.quality, s.stageAt.pairs);
  assert.equal(s.coverage.total, cov.summary.total);
  await call("POST", "/run", { body: { engine: "jev", stages: { coverage: false, pairs: false } } });
  await finish();
  const again = (await call("GET", "/remarks", { query: { status: "postponed" } })) as { items: unknown[] };
  assert.equal(again.items.length, 1);
  await assert.rejects(call("DELETE", "/remarks/:id", { params: { id: rem.items[0].id } }), /не удаляется/);
  const runs = (await call("GET", "/runs")) as { items: unknown[] };
  assert.equal(runs.items.length, 3);
});

test("docChunks splits by headings; caseDocCandidates finds the fragment a case is about", () => {
  const chunks = docChunks([LOGIN, doc("d2", "Отчёты", "# Выгрузка\n- Отчёт выгружается в PDF\n# Печать\n- Отчёт печатается")]);
  assert.deepEqual(chunks.map((c) => [c.docId, c.heading]), [["d1", "Вход в систему"], ["d2", "Выгрузка"], ["d2", "Печать"]]);
  const cs = [kase("c1", "Выгрузка отчёта", "Нажать «Выгрузить в PDF»", "Отчёт выгружается в PDF"), kase("c2", "Корзина", "Добавить товар", "Товар в корзине")];
  const [pdf, cart] = caseDocCandidates(cs, chunks);
  assert.equal(chunks[pdf[0].chunk].heading, "Выгрузка");
  assert.deepEqual(cart, []);
});

test("judgeCaseDoc: Jev picks the fragment; a partial description gets a chat comment", async () => {
  const c = kase("c1", "Блокировка", "5 раз неверный пароль", "Блок на 15 минут");
  const frags = [{ title: "Вход", text: "Пароль не менее 8 символов" }, { title: "Вход › Блокировка", text: "После 5 попыток блок на 15 минут" }];
  const sure = fakeLlm({ choice: { documentation: "documented", fragment: "frag_2" } });
  const v = await judgeCaseDoc(sure, c, frags, { engine: "jev", chat: true, threshold: 0.7 });
  assert.deepEqual([v.status, v.fragment, sure.chats], ["documented", 1, 0]);
  const partial = fakeLlm({ choice: { documentation: "partial", fragment: "frag_2" }, chatText: '{"status":"partial","fragment":"frag_2","confidence":0.8,"comment":"срок блокировки не описан"}' });
  const p = await judgeCaseDoc(partial, c, frags, { engine: "jev", chat: true, threshold: 0.7 });
  assert.deepEqual([p.status, p.comment, p.engine], ["partial", "срок блокировки не описан", "jev+chat"]);
  const none = await judgeCaseDoc(fakeLlm({ choice: { documentation: "undocumented", fragment: "frag_1" } }), c, frags, { engine: "jev" });
  assert.equal(none.fragment, undefined);
});

test("the casedocs stage lists cases without documentation for testcases-view", async () => {
  const routes = new Map<string, Handler>();
  const files = new Map<string, unknown>();
  const cases = [
    kase("c1", "Блокировка после неудачных попыток", "Ввести неверный пароль 5 раз", "Аккаунт блокируется на 15 минут"),
    kase("c2", "Корзина", "Добавить товар в корзину", "Товар в корзине"),
  ];
  register({
    route: (m: string, p: string, h: Handler) => void routes.set(`${m} ${p}`, h),
    files: { read: async (n: string) => structuredClone(files.get(n) ?? null), write: async (n: string, v: unknown) => void files.set(n, structuredClone(v)) },
    data: { docs: async () => [LOGIN], cases: async () => cases },
    llm: fakeLlm({ choice: { documentation: "documented", fragment: "frag_1" } }),
    log: () => {},
  } as unknown as ServerModuleContext);
  const call = (m: string, p: string, o: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}) =>
    routes.get(`${m} ${p}`)!({ params: o.params ?? {}, query: o.query ?? {}, body: o.body });
  await call("POST", "/run", { body: { engine: "jev", stages: { quality: false, coverage: false, pairs: false } } });
  for (let i = 0; i < 100 && ((await call("GET", "/status")) as { run: { running: boolean } }).run.running; i++) await new Promise((r) => setTimeout(r, 5));
  const r = (await call("GET", "/case-docs")) as { at: string; summary: { documented: number; undocumented: number }; items: { caseId: string; status: string; reason?: string; doc?: { id: string } }[] };
  assert.ok(r.at);
  assert.deepEqual([r.summary.documented, r.summary.undocumented], [1, 1]);
  assert.deepEqual(r.items.find((x) => x.caseId === "c2"), { ...r.items.find((x) => x.caseId === "c2"), status: "undocumented", reason: "no-candidates" });
  assert.equal(r.items.find((x) => x.caseId === "c1")?.doc?.id, "d1");
  const ctx = (await call("GET", "/case-docs/:caseId/context", { params: { caseId: "c2" } })) as { text: string };
  assert.match(ctx.text, /не описан в документации/);
});
