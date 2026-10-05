// OpenRouter: OpenAI-compatible chat completions. The model is whatever id the user typed in settings.
import type { ChatChunk, ChatMessage, ToolSpec, Usage } from "@trellis/core";
import { errorFrom, LlmError, readSse, sendWithRetry } from "./sse.ts";

export const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";

export interface OpenRouterRequest {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  signal?: AbortSignal;
  fetch?: typeof fetch;
  /** Pauses between retries on 429/5xx; [] disables retries. */
  retryDelaysMs?: number[];
}

function toOpenAi(m: ChatMessage) {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.arguments } })),
    };
  }
  return { role: m.role, content: m.content };
}

export async function* openRouterChat(req: OpenRouterRequest): AsyncGenerator<ChatChunk> {
  // Free models are often rate-limited upstream: retry before any output was streamed.
  const delays = req.retryDelaysMs ?? [1500, 4000, 8000];
  const res = await sendWithRetry(() => send(req), delays, req.signal);
  if (!res.ok || !res.body) {
    const err = await errorFrom(res, "OpenRouter");
    if (res.status === 429) {
      err.message = `OpenRouter: 429, модель перегружена или упёрлась в лимит (у бесплатных моделей это частое явление). ` +
        `Повторы (${delays.length}) не помогли: попробуйте позже или выберите другую модель.`;
    }
    throw err;
  }
  yield* stream(res.body);
}

function send(req: OpenRouterRequest) {
  return (req.fetch ?? fetch)(OPENROUTER_URL, {
    method: "POST",
    signal: req.signal,
    headers: {
      Authorization: `Bearer ${req.apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://127.0.0.1:5173",
      "X-Title": "Trellis",
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages.map(toOpenAi),
      tools: req.tools?.length
        ? req.tools.map((t) => ({ type: "function", function: t }))
        : undefined,
      stream: true,
      usage: { include: true },
    }),
  });
}

async function* stream(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatChunk> {
  let usage: Usage | undefined;
  const calls = new Map<number, { id: string; name: string; arguments: string }>();
  for await (const ev of readSse(body)) {
    if (ev.data === "[DONE]") break;
    const j = JSON.parse(ev.data);
    if (j.error) throw new LlmError(502, `OpenRouter: ${j.error.message ?? JSON.stringify(j.error)}`);
    const delta = j.choices?.[0]?.delta;
    if (delta?.content) yield { type: "text", delta: delta.content };
    for (const tc of delta?.tool_calls ?? []) {
      const cur = calls.get(tc.index) ?? { id: "", name: "", arguments: "" };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
    if (j.usage) {
      usage = {
        inputTokens: j.usage.prompt_tokens ?? 0,
        outputTokens: j.usage.completion_tokens ?? 0,
        costUsd: Number(j.usage.cost ?? 0),
        ...(j.model ? { model: String(j.model) } : {}),
      };
    }
  }
  for (const call of calls.values()) yield { type: "tool-call", call };
  if (usage) yield { type: "usage", usage };
  yield { type: "done" };
}
