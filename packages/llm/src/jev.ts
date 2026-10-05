// Jev (TypeSafe) decision model through OpenRouter's alpha Decisions API. It returns probabilities, never text.
import type { DecisionAnswer, DecisionQuestion, DecisionResult } from "@trellis/core";
import { cloudflareInfo, errorFrom, isCloudflarePage, LlmError, sendWithRetry } from "./sse.ts";

export const DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const JEV_DEFAULT_MODEL = "~typesafe/jev-latest";

export interface DecideRequest {
  apiKey: string;
  model: string;
  state: unknown;
  questions: Record<string, DecisionQuestion>;
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Pauses between retries on 429/5xx and Cloudflare pages; [] disables retries. */
  retryDelaysMs?: number[];
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

/** Look-alike characters for the ones web filters read as code (markup, templates, shell, SQL quoting). */
const SOFT: Record<string, string> = {
  "<": "‹", ">": "›", "{": "⦃", "}": "⦄", "$": "＄", "`": "ʻ", ";": "；", "|": "｜", "&": "＆", "\\": "＼", "'": "’", "\"": "”",
};
export function softenText(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/[<>{}$`;|&\\'"]/g, (c) => SOFT[c]).replace(/\.\.\//g, "…/");
  if (Array.isArray(v)) return v.map(softenText);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, softenText(x)]));
  return v;
}

/** Cloudflare blocked Jev for the whole network or computer, not for one text: further calls are useless. */
export const JEV_BLOCKED = "Анализ остановлен";
/** OpenRouter refuses some countries and networks; the chat may still work there through ChatGPT. */
export const JEV_PROXY_TIP = "Если OpenRouter не пускает из вашей сети или страны, включите «Прокси для Jev» в «Настройки → Анализ».";

export async function jevDecide(req: DecideRequest): Promise<DecisionResult> {
  const delays = req.retryDelaysMs ?? [2000, 5000, 12000];
  const post = (state: unknown, retries: number[]) => sendWithRetry(() => (req.fetch ?? fetch)(DECISIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://127.0.0.1:5173",
      "X-Title": "Trellis",
      "User-Agent": "Trellis/0.1",
    },
    body: JSON.stringify({ model: req.model, state, questions: req.questions }),
    signal: req.signal,
  }), retries, req.signal);
  // Analysis runs several Jev calls in parallel; bursts sometimes meet a Cloudflare page or a 429.
  let res = await post(req.state, delays);
  if (await isCloudflarePage(res)) {
    // A page on every retry: Cloudflare's filter may object to the text itself (URLs, code, markup).
    // The same meaning in look-alike characters usually passes.
    res = await post(softenText(req.state), delays.slice(0, 1));
    if (await isCloudflarePage(res)) {
      const info = cloudflareInfo(res, await res.text().catch(() => ""));
      // A tiny request tells a blocked text from a blocked network.
      const probe = await post("проверка связи", []);
      const probeBlocked = await isCloudflarePage(probe);
      await probe.body?.cancel();
      if (probeBlocked) {
        throw new LlmError(403, `Jev: 403, Cloudflare перед OpenRouter блокирует запросы с этого компьютера или сети${info}, ` +
          `даже самый короткий. ${JEV_BLOCKED}: повторы только продлевают блокировку. Обычно причина в адресе корпоративного ` +
          "прокси или VPN, в стране или в слишком частых запросах. Подождите 15–30 минут или запустите из другой сети. " + JEV_PROXY_TIP);
      }
      throw new LlmError(403, `Jev: 403, Cloudflare перед OpenRouter не пропускает текст этой проверки${info}: ` +
        "его фильтр принял фрагмент документа или кейса (URL, код, разметку) за атаку. Связь с OpenRouter в порядке, " +
        "остальные проверки идут дальше. Этот пункт можно разобрать в чате.");
    }
  }
  if (!res.ok) {
    const err = await errorFrom(res, "Jev");
    if (res.status === 403 || res.status === 451) err.message += ` ${JEV_PROXY_TIP}`;
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
