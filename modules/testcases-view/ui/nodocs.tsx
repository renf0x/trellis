// «Тесты без документации»: cases the compare stage «Кейсы без документации» found undescribed in the docs.
import { useEffect, useState } from "react";
import { ExternalLink, MessageSquarePlus } from "lucide-react";
import type { ModuleUiProps } from "@trellis/core";
import { openInWorkChat } from "@trellis/ui";

export type View = "all" | "nodocs";
export const VIEW_KEY = "trellis.testcases.view";

type Status = "documented" | "partial" | "undocumented" | "unchecked" | "error";
interface Ref { id: string; title: string; url?: string }
interface Item {
  caseId: string;
  status: Status;
  reason?: "no-candidates";
  heading?: string;
  similarity?: number;
  verdict?: { confidence: number; comment?: string; engine: string };
  error?: string;
  case?: Ref & { externalId: string };
  doc?: Ref & { path: string };
}
interface Response {
  at: string | null;
  summary: { total: number; documented: number; partial: number; undocumented: number; unchecked: number; errors: number };
  items: Item[];
}

const GROUPS: { title: string; hint: string; match: (s: Status) => boolean }[] = [
  { title: "Без документации", hint: "Документация не описывает то, что проверяет кейс", match: (s) => s === "undocumented" },
  { title: "Описаны частично", hint: "Часть проверок кейса в документации не найдена", match: (s) => s === "partial" },
  { title: "Не проверены", hint: "Не вошли в лимит прогона или проверка завершилась ошибкой", match: (s) => s === "unchecked" || s === "error" },
];

export function NoDocs({ api, navigate, selected, onSelect }: Pick<ModuleUiProps, "api" | "navigate"> & {
  selected: string | null; onSelect(id: string): void;
}) {
  const [data, setData] = useState<Response | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.get<Response>("/api/m/compare/case-docs").then(setData, (e: Error) =>
      setError(/404|not found/i.test(e.message) ? "Модуль «Сравнение» выключен: включите его в настройках" : e.message));
  }, [api]);

  async function toChat(x: Item) {
    try {
      const ctx = await api.get<{ title: string; text: string }>(`/api/m/compare/case-docs/${encodeURIComponent(x.caseId)}/context`);
      openInWorkChat({ kind: "case", key: `case:${x.caseId}`, title: ctx.title }, { title: `Без документации: ${ctx.title}`, text: ctx.text });
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (error) return <p className="p-4 text-sm text-bad">{error}</p>;
  if (!data) return <p className="p-4 text-sm text-dim">Загрузка…</p>;
  if (!data.at) {
    return (
      <div className="p-4 text-sm text-dim">
        Проверка ещё не запускалась. Запустите анализ в разделе{" "}
        <button onClick={() => navigate("compare")} className="text-accent">«Сравнение»</button> с этапом «Кейсы без документации».
      </div>
    );
  }
  const s = data.summary;
  return (
    <div className="min-h-0 flex-1 overflow-auto p-3 text-sm">
      <div className="mb-3 text-xs text-faint">
        Проверка от {new Date(data.at).toLocaleString("ru")}: проверено кейсов {s.total}, описаны {s.documented}, без документации {s.undocumented},
        частично {s.partial}{s.unchecked ? `, не проверены ${s.unchecked}` : ""}{s.errors ? `, ошибки ${s.errors}` : ""}.
      </div>
      {GROUPS.map((g) => {
        const items = data.items.filter((x) => g.match(x.status));
        if (!items.length) return null;
        return (
          <section key={g.title} className="mb-4">
            <h3 className="mb-1 font-semibold" title={g.hint}>{g.title} <span className="text-faint">{items.length}</span></h3>
            <div className="space-y-1.5">
              {items.map((x) => (
                <div key={x.caseId} onClick={() => onSelect(x.caseId)}
                  className={`cursor-pointer rounded-lg border px-3 py-2 ${selected === x.caseId ? "border-accent bg-accent-soft" : "border-line hover:bg-raised"}`}>
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <span className="text-faint">#{x.case?.externalId}</span> {x.case?.title ?? x.caseId}
                    </div>
                    <button onClick={(e) => (e.stopPropagation(), void toChat(x))} title="Обсудить в чате «Рабочего места»: кейс и ближайшая документация"
                      className="inline-flex shrink-0 items-center gap-1 text-xs text-accent">
                      <MessageSquarePlus size={12} /> В чат
                    </button>
                    {x.case?.url && (
                      <a href={x.case.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} title="Открыть в источнике"
                        className="shrink-0 text-faint hover:text-ink"><ExternalLink size={13} /></a>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-dim">
                    {x.reason === "no-candidates" ? "Похожих фрагментов документации нет"
                      : x.status === "error" ? `Ошибка проверки: ${x.error ?? ""}`
                      : x.doc ? <>Ближайшее: {x.doc.title}{x.heading ? ` › ${x.heading}` : ""}{x.similarity ? ` · сходство ${Math.round(x.similarity * 100)}%` : ""}</>
                      : null}
                    {x.verdict && <span className="text-faint"> · уверенность {Math.round(x.verdict.confidence * 100)}%</span>}
                  </div>
                  {x.verdict?.comment && <div className="mt-1 text-xs text-dim">{x.verdict.comment}</div>}
                </div>
              ))}
            </div>
          </section>
        );
      })}
      {!s.undocumented && !s.partial && !s.unchecked && !s.errors && <p className="text-dim">Все проверенные кейсы описаны в документации.</p>}
    </div>
  );
}
