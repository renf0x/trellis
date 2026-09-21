import { useEffect, useState } from "react";
import type { ChatBucket, CostTier, ModuleUiProps } from "@trellis/core";
import { TIER_LABEL } from "@trellis/ui";

interface Totals { requests: number; inputTokens: number; outputTokens: number; costUsd: number }
interface UsageResponse {
  days: number;
  tiers: Record<CostTier, Totals>;
  models: (Totals & { tier: CostTier; provider: string; model: string; bucket: ChatBucket })[];
}

const TIERS: CostTier[] = ["paid", "free", "subscription"];
const TIER_CLS: Record<CostTier, string> = { paid: "text-warn", free: "text-ok", subscription: "text-[#7aa2ff]" };
const BUCKET: Record<ChatBucket, string> = { main: "Основной", dev: "Доработки" };
const n = (v: number) => v.toLocaleString("ru");

// Free, paid and subscription usage are deliberately shown apart, never as one sum.
export default function TokenStats({ api }: ModuleUiProps) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<UsageResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api.get<UsageResponse>(`/api/llm/usage?days=${days}`).then(setData, (e: Error) => setError(e.message));
  }, [api, days]);

  return (
    <div className="max-w-5xl space-y-4">
      <header className="flex items-center gap-3">
        <h1 className="text-xl font-semibold">Использование токенов</h1>
        <div className="ml-auto inline-flex rounded-lg border border-line p-0.5 text-sm">
          {[1, 7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={`rounded-md px-3 py-1 ${d === days ? "bg-accent" : "text-dim"}`}>
              {d === 1 ? "Сутки" : `${d} дн.`}
            </button>
          ))}
        </div>
      </header>
      {error && <p className="text-bad">{error}</p>}
      {data && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {TIERS.map((t) => {
              const v = data.tiers[t];
              return (
                <section key={t} className="rounded-xl border border-line bg-panel p-4">
                  <div className={`text-sm ${TIER_CLS[t]}`}>{TIER_LABEL[t]}</div>
                  <div className="mt-2 text-2xl font-semibold">
                    {t === "paid" ? `$${v.costUsd.toFixed(4)}` : `${n(v.inputTokens + v.outputTokens)} ток.`}
                  </div>
                  <div className="mt-1 text-xs text-dim">
                    Запросов: {n(v.requests)} · вход {n(v.inputTokens)} · выход {n(v.outputTokens)}
                    {t === "subscription" && " · в счёт подписки"}
                  </div>
                </section>
              );
            })}
          </div>
          <section className="rounded-xl border border-line bg-panel">
            <table className="w-full text-sm">
              <thead className="text-left text-xs text-faint">
                <tr className="border-b border-line">
                  <th className="p-3 font-normal">Модель</th><th className="font-normal">Тип</th><th className="font-normal">Чат</th>
                  <th className="text-right font-normal">Запросы</th><th className="text-right font-normal">Токены (вход/выход)</th>
                  <th className="p-3 text-right font-normal">Стоимость</th>
                </tr>
              </thead>
              <tbody>
                {data.models.length === 0 && (
                  <tr><td colSpan={6} className="p-4 text-center text-dim">За период запросов не было.</td></tr>
                )}
                {data.models.map((m) => (
                  <tr key={`${m.tier}|${m.model}|${m.bucket}`} className="border-b border-line/50 last:border-0">
                    <td className="p-3 font-mono text-xs">{m.model}</td>
                    <td className={TIER_CLS[m.tier]}>{TIER_LABEL[m.tier]}</td>
                    <td className="text-dim">{BUCKET[m.bucket]}</td>
                    <td className="text-right">{n(m.requests)}</td>
                    <td className="text-right">{n(m.inputTokens)} / {n(m.outputTokens)}</td>
                    <td className="p-3 text-right">{m.tier === "paid" ? `$${m.costUsd.toFixed(5)}` : m.tier === "free" ? "free" : "подписка"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </div>
  );
}
