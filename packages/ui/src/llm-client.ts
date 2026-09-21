// Browser client for /api/llm: settings, streaming chat (NDJSON) and usage.
import type { ChatBucket, CostTier, Usage } from "@trellis/core";

export type ProviderId = "openrouter" | "chatgpt";
export interface BucketSettings {
  provider: ProviderId;
  openrouter: { model: string; free: boolean };
  chatgpt: { model: string; effort: string };
}
export interface LlmStatus {
  openrouter: { hasKey: boolean; keyHint: string | null; fromEnv: boolean };
  chatgpt: { loggedIn: boolean; email?: string | null; plan?: string | null };
  login: { url: string } | null;
}
export interface LlmSettingsResponse {
  settings: Record<ChatBucket, BucketSettings>;
  status: LlmStatus;
}

export type StreamEvent =
  | { type: "meta"; provider: ProviderId; model: string; tier: CostTier }
  | { type: "text"; delta: string }
  | { type: "usage"; usage: Usage; tier: CostTier }
  | { type: "error"; message: string }
  | { type: "done" };

export const TIER_LABEL: Record<CostTier, string> = {
  free: "OpenRouter · free",
  paid: "OpenRouter · платные",
  subscription: "ChatGPT · подписка",
};

/** Human label of the model a bucket currently uses. */
export function modelLabel(s: BucketSettings | undefined): string | null {
  if (!s) return null;
  if (s.provider === "openrouter") return s.openrouter.model ? `${s.openrouter.model}${s.openrouter.free ? " · free" : ""}` : null;
  return `ChatGPT · ${s.chatgpt.model || "авто"}`;
}

export async function* streamChat(
  bucket: ChatBucket,
  messages: { role: "user" | "assistant"; content: string }[],
  sessionId: string,
  signal: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const res = await fetch("/api/llm/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ bucket, messages, sessionId }),
    signal,
  });
  if (!res.ok || !res.body) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j.error ?? `${res.status} ${res.statusText}`);
  }
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += value;
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line) as StreamEvent;
    }
    if (done) return;
  }
}
