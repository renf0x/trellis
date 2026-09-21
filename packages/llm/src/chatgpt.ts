// ChatGPT subscription (Plus/Pro/Business) through the same OAuth flow and backend as the Codex CLI,
// the way opencode's Codex auth plugin does it. Requests are billed to the subscription, not an API key.
import { createHash, randomBytes } from "node:crypto";
import type { ChatChunk, ChatMessage, ToolSpec, Usage } from "@trellis/core";
import { errorFrom, LlmError, readSse } from "./sse.ts";

export const CHATGPT_OAUTH = {
  clientId: "app_EMoamEEZ73f0CkXaXp7hrann",
  authorizeUrl: "https://auth.openai.com/oauth/authorize",
  tokenUrl: "https://auth.openai.com/oauth/token",
  /** Registered for this client id; the port cannot be changed. */
  redirectUri: "http://localhost:1455/auth/callback",
  callbackPort: 1455,
  scope: "openid profile email offline_access",
};
export const CODEX_BASE = "https://chatgpt.com/backend-api/codex";
// The backend hides models whose minimal_client_version is above this, so keep it well ahead of Codex releases.
const CLIENT_VERSION = "1.0.0";

export interface ChatGptTokens {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  /** Epoch ms. */
  expiresAt: number;
  accountId: string;
  email?: string;
  plan?: string;
}

export interface ChatGptModel {
  id: string;
  title: string;
  description?: string;
  efforts: string[];
  defaultEffort?: string;
}

/** Fallback when the backend model list is unavailable; the live list is preferred. */
export const FALLBACK_CHATGPT_MODELS: ChatGptModel[] = [
  { id: "gpt-5.6-sol", title: "GPT-5.6 Sol", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "low" },
  { id: "gpt-5.6-terra", title: "GPT-5.6 Terra", efforts: ["low", "medium", "high", "xhigh", "max", "ultra"], defaultEffort: "medium" },
  { id: "gpt-5.6-luna", title: "GPT-5.6 Luna", efforts: ["low", "medium", "high", "xhigh", "max"], defaultEffort: "medium" },
  { id: "gpt-5.5", title: "GPT-5.5", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
];

/** Models the owner does not want offered: they burn the subscription limit too fast. */
export const EXCLUDED_CHATGPT_MODELS = new Set(["gpt-6-astra"]);

/** "GPT-5.6-Sol" -> "GPT-5.6 Sol", matching how Codex shows names. */
const prettyTitle = (name: string) => name.replace(/-(?=[A-Za-z])/g, " ");

const b64url = (buf: Buffer) => buf.toString("base64url");

export function createPkce() {
  const verifier = b64url(randomBytes(32));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()), state: b64url(randomBytes(16)) };
}

export function buildAuthorizeUrl(challenge: string, state: string): string {
  const u = new URL(CHATGPT_OAUTH.authorizeUrl);
  const p = {
    response_type: "code",
    client_id: CHATGPT_OAUTH.clientId,
    redirect_uri: CHATGPT_OAUTH.redirectUri,
    scope: CHATGPT_OAUTH.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    originator: "codex_cli_rs",
  };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return u.toString();
}

export function decodeJwt(token: string | undefined): Record<string, any> {
  try {
    return JSON.parse(Buffer.from(token!.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

export function tokensFromResponse(json: any, prev?: ChatGptTokens): ChatGptTokens {
  const idToken: string | undefined = json.id_token ?? prev?.idToken;
  const claims = { ...decodeJwt(json.access_token), ...decodeJwt(idToken) };
  const auth = claims["https://api.openai.com/auth"] ?? {};
  const accountId = auth.chatgpt_account_id ?? prev?.accountId;
  if (!json.access_token || !accountId) throw new LlmError(502, "ChatGPT: в ответе нет access_token или chatgpt_account_id");
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token ?? prev?.refreshToken,
    idToken,
    expiresAt: Date.now() + Number(json.expires_in ?? 3600) * 1000,
    accountId,
    email: claims.email ?? claims["https://api.openai.com/profile"]?.email ?? prev?.email,
    plan: auth.chatgpt_plan_type ?? prev?.plan,
  };
}

async function tokenRequest(body: Record<string, string>, f: typeof fetch) {
  const res = await f(CHATGPT_OAUTH.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CHATGPT_OAUTH.clientId, ...body }).toString(),
  });
  if (!res.ok) throw await errorFrom(res, "ChatGPT OAuth");
  return res.json();
}

export async function exchangeCode(code: string, verifier: string, f: typeof fetch = fetch) {
  const json = await tokenRequest(
    { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: CHATGPT_OAUTH.redirectUri },
    f,
  );
  return tokensFromResponse(json);
}

export async function refreshTokens(t: ChatGptTokens, f: typeof fetch = fetch) {
  return tokensFromResponse(await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refreshToken }, f), t);
}

function headers(t: ChatGptTokens, sessionId?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${t.accessToken}`,
    "chatgpt-account-id": t.accountId,
    "OpenAI-Beta": "responses=experimental",
    originator: "codex_cli_rs",
    ...(sessionId ? { session_id: sessionId } : {}),
  };
}

/** Live model list for this account (same endpoint the Codex CLI uses), hidden models removed. */
export async function listChatGptModels(t: ChatGptTokens, f: typeof fetch = fetch): Promise<ChatGptModel[]> {
  const res = await f(`${CODEX_BASE}/models?client_version=${CLIENT_VERSION}`, { headers: headers(t) });
  if (!res.ok) throw await errorFrom(res, "ChatGPT models");
  const json: any = await res.json();
  const raw: any[] = Array.isArray(json) ? json : json.models ?? json.data ?? [];
  const models = raw
    .filter((m) => (m.visibility ?? "list") === "list" && (m.slug ?? m.id) && !EXCLUDED_CHATGPT_MODELS.has(String(m.slug ?? m.id)))
    .map((m) => ({
      id: String(m.slug ?? m.id),
      title: prettyTitle(String(m.display_name ?? m.slug ?? m.id)),
      description: m.description,
      efforts: (m.supported_reasoning_levels ?? []).map((l: any) => (typeof l === "string" ? l : l.effort)).filter(Boolean),
      defaultEffort: m.default_reasoning_level,
    }));
  if (!models.length) throw new LlmError(502, "ChatGPT models: пустой список");
  return models;
}

function toResponsesInput(messages: ChatMessage[]) {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "user") input.push({ type: "message", role: "user", content: [{ type: "input_text", text: m.content }] });
    else if (m.role === "tool") input.push({ type: "function_call_output", call_id: m.toolCallId, output: m.content });
    else if (m.role === "assistant") {
      if (m.content) input.push({ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] });
      for (const c of m.toolCalls ?? []) input.push({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments });
    }
  }
  return input;
}

export interface ChatGptRequest {
  tokens: ChatGptTokens;
  model: string;
  effort?: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  sessionId?: string;
  signal?: AbortSignal;
  fetch?: typeof fetch;
}

export async function* chatGptChat(req: ChatGptRequest): AsyncGenerator<ChatChunk> {
  const f = req.fetch ?? fetch;
  const instructions = req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n")
    || "You are a helpful assistant.";
  const res = await f(`${CODEX_BASE}/responses`, {
    method: "POST",
    signal: req.signal,
    headers: { ...headers(req.tokens, req.sessionId), "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify({
      model: req.model,
      instructions,
      input: toResponsesInput(req.messages),
      tools: (req.tools ?? []).map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters })),
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: req.effort ? { effort: req.effort, summary: "auto" } : undefined,
      store: false,
      stream: true,
      include: ["reasoning.encrypted_content"],
      prompt_cache_key: req.sessionId,
    }),
  });
  if (!res.ok || !res.body) throw await errorFrom(res, "ChatGPT");

  let usage: Usage | undefined;
  for await (const ev of readSse(res.body)) {
    let j: any;
    try {
      j = JSON.parse(ev.data);
    } catch {
      continue;
    }
    const type = j.type ?? ev.event;
    if (type === "response.output_text.delta" && j.delta) yield { type: "text", delta: j.delta };
    else if (type === "response.output_item.done" && j.item?.type === "function_call") {
      yield { type: "tool-call", call: { id: j.item.call_id, name: j.item.name, arguments: j.item.arguments ?? "" } };
    } else if (type === "response.completed" || type === "response.done") {
      const u = j.response?.usage;
      if (u) usage = { inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, costUsd: 0, subscription: true, ...(j.response?.model ? { model: String(j.response.model) } : {}) };
    } else if (type === "response.failed" || type === "error") {
      const e = j.response?.error ?? j.error ?? j;
      throw new LlmError(502, `ChatGPT: ${e.message ?? JSON.stringify(e).slice(0, 300)}`);
    }
  }
  if (usage) yield { type: "usage", usage };
  yield { type: "done" };
}
