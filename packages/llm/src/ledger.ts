// Append-only token ledger (JSONL). Stage 7 may move it to SQLite; the entry shape stays.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { CostTier, LedgerEntry, UsageBucket } from "@trellis/core";

export class Ledger {
  constructor(private file: string) {}

  async append(entry: LedgerEntry): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await appendFile(this.file, JSON.stringify(entry) + "\n", "utf8");
  }

  async read(sinceMs = 0): Promise<LedgerEntry[]> {
    let text = "";
    try {
      text = await readFile(this.file, "utf8");
    } catch {
      return [];
    }
    const out: LedgerEntry[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line) as LedgerEntry;
        if (Date.parse(e.at) >= sinceMs) out.push(e);
      } catch {
        /* skip a torn line */
      }
    }
    return out;
  }
}

export interface Totals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  tiers: Record<CostTier, Totals>;
  models: (Totals & { tier: CostTier; provider: string; model: string; bucket: UsageBucket })[];
}

const zero = (): Totals => ({ requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 });
function add(t: Totals, e: LedgerEntry) {
  t.requests += 1;
  t.inputTokens += e.usage.inputTokens;
  t.outputTokens += e.usage.outputTokens;
  t.costUsd += e.usage.costUsd;
}

/** Free, paid and subscription usage are kept apart: they are never added into one total. */
export function summarize(entries: LedgerEntry[]): UsageSummary {
  const tiers: UsageSummary["tiers"] = { free: zero(), paid: zero(), subscription: zero() };
  const models = new Map<string, UsageSummary["models"][number]>();
  for (const e of entries) {
    add(tiers[e.tier], e);
    const key = [e.tier, e.provider, e.model, e.bucket].join("|");
    const row = models.get(key) ?? { ...zero(), tier: e.tier, provider: e.provider, model: e.model, bucket: e.bucket };
    add(row, e);
    models.set(key, row);
  }
  return { tiers, models: [...models.values()].sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens)) };
}
