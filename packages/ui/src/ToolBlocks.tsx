// Tool blocks in chat answers: what the model asked a tool to do (```trellis-browser) and what came back
// (```trellis-result, written by the server). Shown as short lines instead of raw JSON.
import { Check, Globe, X } from "lucide-react";

const BLOCK = /```trellis-([a-z][a-z0-9-]*)[^\n]*\n([\s\S]*?)(?:```|$)/g;

export type ToolSegment =
  | { kind: "text"; text: string }
  | { kind: "call"; tool: string; raw: string }
  | { kind: "result"; raw: string };

/** Splits text into plain parts and tool blocks; trellis-change blocks are left in the text for ChangeCard. */
export function splitToolBlocks(text: string): ToolSegment[] {
  const out: ToolSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(BLOCK)) {
    if (m[1] === "change") continue;
    if (m.index > last) out.push({ kind: "text", text: text.slice(last, m.index) });
    out.push(m[1] === "result" ? { kind: "result", raw: m[2] } : { kind: "call", tool: m[1], raw: m[2] });
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ kind: "text", text: text.slice(last) });
  // Blocks are drawn as lines of their own: the blank lines around them would only add gaps.
  if (out.length < 2) return out;
  return out.map((s) => (s.kind === "text" ? { ...s, text: s.text.replace(/^\n+|\n+$/g, "") } : s)).filter((s) => s.kind !== "text" || s.text);
}

function parse(raw: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(raw.trim());
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

const ACTION: Record<string, string> = {
  open: "открыть", snapshot: "снимок страницы", click: "нажать", fill: "заполнить", press: "клавиша", select: "выбрать",
  check: "отметить", hover: "навести", wait: "ждать", back: "назад", dialog: "диалог", screenshot: "скриншот",
  verify: "проверить", close: "закрыть вкладку",
};

export function ToolCallLine({ tool, raw }: { tool: string; raw: string }) {
  const v = parse(raw);
  const action = v ? String(v.action ?? "") : "";
  const rest = v
    ? Object.entries(v).filter(([k]) => k !== "action").map(([k, x]) => (k === "ref" ? `[${x}]` : typeof x === "string" ? `«${x}»` : `${k}=${String(x)}`)).join(" ")
    : raw.trim().slice(0, 120);
  return (
    <div className="my-1 flex items-start gap-1.5 font-mono text-[11px] text-dim" title={raw}>
      <Globe size={12} className="mt-0.5 shrink-0 text-faint" />
      <span className="min-w-0 break-words">
        {tool === "browser" ? "" : `${tool}: `}{ACTION[action] ?? action} {rest}
      </span>
    </div>
  );
}

export function ToolResultLine({ raw }: { raw: string }) {
  const v = parse(raw);
  if (!v) return null;
  const ok = v.ok === true;
  const image = typeof v.image === "string" && v.image.startsWith("/api/m/") ? v.image : null;
  return (
    <div className={`my-1 rounded-md border px-2 py-1 text-xs ${ok ? "border-line text-dim" : "border-bad/40 text-bad"}`}>
      <div className="flex items-start gap-1.5">
        {ok ? <Check size={12} className="mt-0.5 shrink-0 text-ok" /> : <X size={12} className="mt-0.5 shrink-0" />}
        <span className="min-w-0 break-words">{String(v.summary ?? "")}</span>
      </div>
      {image && (
        <a href={image} target="_blank" rel="noreferrer" className="mt-1 block w-fit">
          <img src={image} alt="Снимок экрана" className="max-h-48 rounded border border-line" />
        </a>
      )}
    </div>
  );
}
