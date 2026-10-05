// Page snapshots as the chat model reads them, and the Jev check of a step's expected result.
import type { DecisionQuestion, ModuleLlm } from "@trellis/core";

export interface SnapshotElement {
  ref: number;
  tag: string;
  type: string;
  role: string;
  label: string;
  value: string;
  state: string;
}
export interface Snapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  text: string;
  /** The emulated screen, e.g. "360×800, мобильная версия"; absent for the window's own size. */
  screen?: string;
  dialogs?: string[];
  /** Tab changes: a link opened a new tab, a tab closed. */
  notes?: string[];
  /** Page width in CSS px and how far the content sticks out sideways, with the widest elements. */
  layout?: { width: number; overflow: number; wide: string[] };
  /** Console errors and warnings, failed requests since the last snapshot (counts only; details via `console`). */
  console?: { errors: number; warnings: number; failed: number };
  errors?: string[];
}

function kind(e: SnapshotElement) {
  if (e.role) return e.role;
  if (e.tag === "a") return "link";
  if (e.tag === "input") return `input${e.type && e.type !== "text" ? `:${e.type}` : ""}`;
  return e.tag;
}

/** Compact text: numbered elements first (what the model acts on), then the page text cut to `textLimit`. */
export function formatSnapshot(s: Snapshot, textLimit: number): string {
  const lines = [`URL: ${s.url}`, `Заголовок: ${s.title || "—"}`];
  if (s.screen) lines.push(`Экран: ${s.screen}`);
  if (s.layout?.overflow) {
    lines.push(`Вёрстка: страница шире экрана на ${s.layout.overflow} px (ширина ${s.layout.width} px), есть горизонтальная прокрутка`
      + (s.layout.wide.length ? `; выходят за край: ${s.layout.wide.join(", ")}` : ""));
  }
  const c = s.console;
  if (c && (c.errors || c.warnings || c.failed)) {
    lines.push(`Консоль: ошибок ${c.errors}, предупреждений ${c.warnings}, неудачных запросов ${c.failed} (подробно — action console)`);
  }
  if (s.notes?.length) lines.push(`Вкладки: ${s.notes.join("; ")}`);
  if (s.dialogs?.length) lines.push(`Диалоги: ${s.dialogs.join("; ")}`);
  if (s.errors?.length) lines.push(`Ошибки JS на странице: ${s.errors.join("; ")}`);
  lines.push("", s.elements.length ? "Элементы [ref]:" : "Интерактивных элементов не видно.");
  for (const e of s.elements) {
    const value = e.value ? ` = «${e.value}»` : "";
    lines.push(`[${e.ref}] ${kind(e)} «${e.label || "без подписи"}»${value}${e.state ? ` (${e.state})` : ""}`);
  }
  const text = s.text.length > textLimit ? `${s.text.slice(0, textLimit)}\n…[текст обрезан, для проверки шага используйте verify]` : s.text;
  lines.push("", "Текст страницы:", text || "—");
  return lines.join("\n");
}

export type PageVerdict = "matches" | "partial" | "mismatch" | "cannot_tell";

export const VERIFY_QUESTIONS: Record<string, DecisionQuestion> = {
  verdict: {
    type: "choice",
    instructions:
      "A tester ran a step of a test case in a web browser. Decide whether the current page shows the step's expected result. " +
      "Judge only by the page: its URL, title, visible text and interactive elements.",
    criteria: {
      matches: "The page clearly shows the expected result",
      partial: "The page shows part of the expected result, or something close with different values or wording",
      mismatch: "The page shows something else: another page, an error, or values that contradict the expected result",
      cannot_tell: "The page content does not let you decide (the result is not visible as text, e.g. a picture or a style)",
    },
  },
};

export async function pageVerdict(llm: ModuleLlm, expected: string, s: Snapshot, signal?: AbortSignal) {
  const state = {
    expected_result: expected,
    page: { url: s.url, title: s.title, text: s.text.slice(0, 8000), elements: s.elements.slice(0, 80).map((e) => `${kind(e)} ${e.label}${e.value ? ` = ${e.value}` : ""}${e.state ? ` (${e.state})` : ""}`) },
  };
  const r = await llm.decide(state, VERIFY_QUESTIONS, { signal });
  const a = r.answers.verdict;
  if (a?.type !== "choice") throw new Error("Jev не ответил");
  return { choice: a.choice as PageVerdict, confidence: a.confidence };
}
