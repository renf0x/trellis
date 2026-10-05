// LLM provider contract. Implementations live in modules (openrouter, chatgpt-subscription, corporate).

/** Cost bucket: the main QA chat and the dev chat are billed and configured separately. */
export type ChatBucket = "main" | "dev";

/**
 * Chat window: "main" is the side chat for general questions and ideas, "work" is the big analysis chat on the
 * workbench (a tab per report), "dev" is the chat about Trellis itself. "work" uses the main bucket's model and billing.
 */
export type ChatChannel = ChatBucket | "work";
export const CHAT_CHANNELS: readonly ChatChannel[] = ["main", "work", "dev"];
export const channelBucket = (c: ChatChannel): ChatBucket => (c === "dev" ? "dev" : "main");

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
 * Decision model (Jev via OpenRouter /api/alpha/decisions): no text, only probabilities.
 * noul = yes/no probability; choice picks one of `criteria` keys; score rates on the ordered `criteria` list.
 */
export type DecisionQuestion =
  | { type: "noul"; instructions: string }
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] };

export type DecisionAnswer =
  | { type: "noul"; noul: number }
  | { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
  /** `score` is the expected index into `legend` (0..n-1). */
  | { type: "score"; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number };

export interface DecisionResult {
  model: string;
  answers: Record<string, DecisionAnswer>;
  usage: Usage;
}

/** "Анализ" profile in settings. Off by default: companies may not use Jev at all. */
export interface AnalysisSettings {
  jev: {
    enabled: boolean; model: string; threshold: number;
    /** Proxy for Jev requests only; `hint` is scheme, host and port of the saved URL (null when none is saved). */
    proxy?: { enabled: boolean; hint: string | null };
  };
}

/** LLM access for module servers (needs llm:main). Usage is written to the ledger under bucket "analysis". */
export interface ModuleLlm {
  /** Label of the model the main chat is set to, null when none is configured. */
  chatModel(): Promise<string | null>;
  /** One non-streaming answer from the main chat's provider and model. */
  complete(messages: ChatMessage[], opts?: { signal?: AbortSignal }): Promise<{ text: string; model: string; usage?: Usage }>;
  /** Jev decision; rejects when the analysis profile has Jev switched off. */
  decide(state: unknown, questions: Record<string, DecisionQuestion>, opts?: { signal?: AbortSignal }): Promise<DecisionResult>;
  analysis(): Promise<AnalysisSettings>;
}

/**
 * Analytics tier: OpenRouter free models, OpenRouter paid models and the ChatGPT subscription
 * are reported separately and never summed together.
 */
export type CostTier = "free" | "paid" | "subscription";

/** Ledger bucket: the two chats plus batch analysis (compare module), billed apart. */
export type UsageBucket = ChatBucket | "analysis";

/** One row of the token ledger. */
export interface LedgerEntry {
  at: string;
  bucket: UsageBucket;
  provider: string;
  model: string;
  tier: CostTier;
  usage: Usage;
  taskId?: string;
}
