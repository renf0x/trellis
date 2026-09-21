// LLM provider contract. Implementations live in modules (openrouter, chatgpt-subscription, corporate).

/** Cost bucket: the main QA chat and the dev chat are billed and configured separately. */
export type ChatBucket = "main" | "dev";

export type ProviderAuth =
  | { kind: "api-key" } // OpenRouter, corporate gateways
  | { kind: "oauth-subscription" }; // ChatGPT subscription login, tokens stored under data/

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema of the arguments. */
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ChatMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCall[] }
  | { role: "tool"; toolCallId: string; content: string };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  /** USD; 0 for subscription providers (cost is flagged `subscription`). */
  costUsd: number;
  subscription?: boolean;
  /** Model id the provider reports it actually ran (may differ from the requested id). */
  model?: string;
}

export type ChatChunk =
  | { type: "text"; delta: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "usage"; usage: Usage }
  | { type: "done" };

export interface ChatOptions {
  model: string;
  bucket: ChatBucket;
  signal?: AbortSignal;
  temperature?: number;
}

export interface LLMProvider {
  id: string;
  title: string;
  auth: ProviderAuth;
  listModels(): Promise<{ id: string; title: string }[]>;
  chat(messages: ChatMessage[], tools: ToolSpec[], opts: ChatOptions): AsyncIterable<ChatChunk>;
}

/**
 * Analytics tier: OpenRouter free models, OpenRouter paid models and the ChatGPT subscription
 * are reported separately and never summed together.
 */
export type CostTier = "free" | "paid" | "subscription";

/** One row of the token ledger. */
export interface LedgerEntry {
  at: string;
  bucket: ChatBucket;
  provider: string;
  model: string;
  tier: CostTier;
  usage: Usage;
  taskId?: string;
}
