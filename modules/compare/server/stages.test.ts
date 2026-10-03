import { test } from "node:test";
import assert from "node:assert/strict";
import type { DecisionQuestion, DocRecord, ModuleLlm, ServerModuleContext, TestCaseRecord } from "@trellis/core";
import { extractRequirements, judgeCoverage, judgeQuality, parseQuality } from "./stages.ts";
import { register } from "./index.ts";

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
  assert.deepEqual(extractRequirements(LOGIN), [
    "Пароль должен содержать не менее 8 символов",
    "После 5 неудачных попыток аккаунт блокируется на 15 минут",
    "Система должна показывать сообщение об ошибке при неверном пароле.",
    "Email — не более 254 символов",
  ]);
  assert.equal(extractRequirements(LOGIN, 2).length, 2);
});

test("parseQuality clamps scores and keeps known criteria", () => {
  const q = parseQuality('```json\n{"scores":{"consistency":1.5,"atomicity":0.2,"verifiability":"x"},"remarks":[{"criterion":"atomicity","summary":"Два требования в одном пункте"},{"criterion":"zzz","summary":"Прочее"},{"summary":""}]}\n```');
  assert.equal(q.scores.consistency, 1);
  assert.equal(q.scores.verifiability, 0.5);
  assert.deepEqual(q.remarks.map((r) => r.criterion), ["atomicity", "other"]);
});

/** Jev answers every question with the given choice/score; the chat model returns `chatText`. */
function fakeLlm(opts: { choice?: Record<string, string>; score?: number; chatText?: string }): ModuleLlm & { decides: number; chats: number } {
  const llm = {
    decides: 0,
    chats: 0,
    chatModel: async () => "m",
    analysis: async () => ({ jev: { enabled: true, model: "jev", threshold: 0.7 } }),
    decide: async (_s: unknown, qs: Record<string, DecisionQuestion>) => {
      llm.decides++;
      const answers = Object.fromEntries(Object.entries(qs).map(([k, q]) => [k, q.type === "score"
        ? { type: "score" as const, score: opts.score ?? 2, legend: {}, probabilities: {}, confidence: 0.9 }
        : { type: "choice" as const, choice: opts.choice?.[k] ?? Object.keys(q.type === "choice" ? q.criteria : {})[0], probabilities: {}, confidence: 0.9 }]));
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

  await call("POST", "/run", { body: { engine: "jev", stages: { pairs: false } } });
  await finish();
  const quality = (await call("GET", "/quality")) as { items: { docId: string; verdict: { overall: number } }[] };
  assert.equal(quality.items.length, 2);
  const cov = (await call("GET", "/coverage")) as { summary: { total: number; covered: number; notCovered: number; percent: number }; docs: { doc: { id: string }; percent: number }[] };
  // Only the lockout requirement has a similar case; the rest are uncovered without a model call.
  assert.deepEqual([cov.summary.total, cov.summary.covered, cov.summary.notCovered, cov.summary.percent], [6, 1, 5, 17]);
  assert.equal(llm.decides, 2 + 1); // two quality calls, one coverage call
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
