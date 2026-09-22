// Jev (TypeSafe) decision model through OpenRouter's alpha Decisions API. It returns probabilities, never text.
import type { DecisionAnswer, DecisionQuestion, DecisionResult } from "@trellis/core";
import { errorFrom, LlmError } from "./sse.ts";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_DEFAULT_MODEL = "~typesafe/jev-latest";

export interface DecideRequest {
  apiKey: string;
  model: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const probs = (v: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries((v ?? {}) as Record<string, unknown>).map(([k, p]) => [k, num(p)]));

function answer(raw: any): DecisionAnswer {
  if (raw?.type === "noul") return { type: "noul", noul: num(raw.noul) };
  if (raw?.type === "choice") {
    return { type: "choice", choice: String(raw.choice ?? ""), probabilities: probs(raw.probabilities), confidence: num(raw.confidence) };
  }
  if (raw?.type === "score") {
    return {
      type: "score", score: num(raw.score), legend: (raw.legend ?? {}) as Record<string, string>,
      probabilities: probs(raw.probabilities), confidence: num(raw.confidence),
    };
  }
  throw new LlmError(502, `Jev: неизвестный тип ответа ${String(raw?.type)}`);
}

export async function jevDecide(req: DecideRequest): Promise<DecisionResult> {
  const res = await (req.fetch ?? fetch)(DECISIONS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${req.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: req.model, state: req.state, questions: req.questions }),
    signal: req.signal,
  });
  if (!res.ok) {
    const err = await errorFrom(res, "Jev");
    if (res.status === 402) err.message = "Jev: 402, на балансе OpenRouter не хватает средств.";
    if (res.status === 413) err.message = "Jev: 413, документ и кейс вместе слишком велики для модели (32k токенов).";
    throw err;
  }
  const j = (await res.json()) as any;
  const answers: Record<string, DecisionAnswer> = {};
  for (const name of Object.keys(req.questions)) {
    if (!j.answers?.[name]) throw new LlmError(502, `Jev: нет ответа на вопрос ${name}`);
    answers[name] = answer(j.answers[name]);
  }
  return {
    model: String(j.model ?? req.model),
    answers,
    usage: {
      inputTokens: num(j.usage?.input_tokens),
      outputTokens: num(j.usage?.output_tokens),
      costUsd: num(j.usage?.cost),
      model: j.model ? String(j.model) : undefined,
    },
  };
}
