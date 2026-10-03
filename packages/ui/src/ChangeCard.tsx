// Proposed edits from the agent (```trellis-change blocks) as cards in the chat. A card first compares
// the edit with the live record in Qase/Jira/Confluence (nothing is written), shows the difference, and
// writes only after the person presses "Записать" and confirms. The connector re-checks for conflicts.
import { useEffect, useState } from "react";
import { Check, ExternalLink, GitCompare, Upload, X } from "lucide-react";

const BLOCK = /```trellis-change[^\n]*\n([\s\S]*?)```/g;
export type Segment = { kind: "text"; text: string } | { kind: "change"; raw: string };

/** Splits an assistant message into plain text and change blocks; an unfinished block stays text. */
export function splitChanges(content: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of content.matchAll(BLOCK)) {
    if (m.index > last) out.push({ kind: "text", text: content.slice(last, m.index) });
    out.push({ kind: "change", raw: m[1].trim() });
    last = m.index + m[0].length;
  }
  if (last < content.length) out.push({ kind: "text", text: content.slice(last) });
  return out;
}

export interface Proposal {
  pid: string;
  source: string;
  request: { target: string; id: string; reason: string; create?: boolean };
  before: Record<string, string>;
  after: Record<string, string>;
  status: "proposed" | "applied" | "discarded" | "conflict" | "failed";
  error?: string;
  url?: string;
  createdId?: string;
}

const SYSTEMS: Record<string, string> = { qase: "Qase", jira: "Jira", confluence: "Confluence" };
const FIELDS: Record<string, string> = { title: "Название", description: "Описание", preconditions: "Предусловия", steps: "Шаги", text: "Текст страницы", suite: "Сьют" };
const STATUS: Record<Proposal["status"], string> = {
  proposed: "ждёт подтверждения", applied: "записано", discarded: "отклонено", conflict: "конфликт", failed: "ошибка записи",
};

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? `${res.status} ${res.statusText}`);
  return j as T;
}

// Which proposal a block became, so the card shows its status after a reload.
const KEY = "trellis.changes";
const keyOf = (raw: string) => {
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (Math.imul(h, 31) + raw.charCodeAt(i)) | 0;
  return String(h >>> 0);
};
function rememberPid(raw: string, pid?: string) {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, string>;
    if (pid === undefined) return all[keyOf(raw)];
    all[keyOf(raw)] = pid;
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: the card just starts over */
  }
  return undefined;
}

/** `origin` marks where the proposal came from; `onApplied` fires once the change is written. */
export function ChangeCard({ raw, origin = "chat", onApplied }: { raw: string; origin?: string; onApplied?(p: Proposal): void }) {
  let req: { target?: string; id?: string; reason?: string; create?: boolean } | null = null;
  let parseError = "";
  try {
    req = JSON.parse(raw);
  } catch (e) {
    parseError = (e as Error).message;
  }
  const system = typeof req?.id === "string" ? req.id.split(":")[0] : "";
  const base = `/api/m/connector-${system}`;
  const [p, setP] = useState<Proposal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const pid = rememberPid(raw);
    if (pid && SYSTEMS[system]) call<Proposal>("GET", `${base}/changes/${pid}`).then(setP, () => {});
  }, [raw, base, system]);

  const run = async (f: () => Promise<Proposal>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await f();
      setP(next);
      rememberPid(raw, next.pid);
      if (next.status === "applied") onApplied?.(next);
    } catch (e) {
      setError((e as Error).message);
      if (p) call<Proposal>("GET", `${base}/changes/${p.pid}`).then(setP, () => {});
    } finally {
      setBusy(false);
    }
  };

  if (!req || !SYSTEMS[system]) {
    return (
      <div className="my-2 rounded-lg border border-bad/40 p-2 text-xs text-bad">
        Правка не распознана{parseError ? `: ${parseError}` : `: неизвестная система «${system || "?"}»`}
      </div>
    );
  }
  const name = SYSTEMS[system];
  const open = p?.status === "proposed" || p?.status === "failed";

  return (
    <div className="my-2 rounded-lg border border-line bg-panel p-2.5 text-xs">
      <div className="flex items-center gap-1.5">
        <GitCompare size={13} className="shrink-0 text-accent" />
        <span className="font-medium">{req.create ? `Новый кейс в ${name}` : `Правка в ${name}`}</span>
        <span className="truncate text-faint">{req.id}</span>
        {p?.url && <a href={p.url} target="_blank" rel="noreferrer" className="ml-auto text-faint hover:text-ink"><ExternalLink size={12} /></a>}
      </div>
      {req.reason && <div className="mt-1 text-dim">{req.reason}</div>}

      {p && (
        <div className="mt-2 space-y-2">
          {Object.keys(p.after).map((k) => (
            <div key={k}>
              <div className="mb-0.5 text-faint">{FIELDS[k] ?? k}</div>
              <Diff before={p.before[k]} after={p.after[k]} />
            </div>
          ))}
          <div className={p.status === "applied" ? "text-ok" : p.status === "proposed" ? "text-dim" : "text-warn"}>
            {p.status === "applied" && p.createdId ? `создан ${p.createdId.split(":")[1]}` : STATUS[p.status]}{p.error ? `: ${p.error}` : ""}
          </div>
        </div>
      )}
      {error && <div className="mt-1.5 text-bad">{error}</div>}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {(!p || p.status === "conflict" || p.status === "discarded") && (
          <button disabled={busy} onClick={() => void run(() => call("POST", `${base}/changes`, { ...req, origin }))}
            title={`Читает текущую версию из ${name} и показывает разницу. Ничего не записывает.`}
            className="flex items-center gap-1 rounded-md border border-line px-2 py-1 hover:bg-raised disabled:opacity-40">
            <GitCompare size={12} /> {req.create ? (p ? "Проверить заново" : "Показать, что будет создано") : p ? "Сравнить заново" : `Сравнить с ${name}`}
          </button>
        )}
        {open && (
          <>
            <button disabled={busy}
              onClick={() => confirm(req!.create
                ? `Создать новый кейс в ${name} (${req!.id})? Его увидят все в ${name}.`
                : `Записать правку в ${name} (${req!.id})? Изменение увидят все в ${name}.`)
                && void run(() => call("POST", `${base}/changes/${p!.pid}/apply`, { confirm: true }))}
              className="flex items-center gap-1 rounded-md bg-accent px-2 py-1 disabled:opacity-40">
              <Upload size={12} /> {req.create ? `Создать в ${name}` : `Записать в ${name}`}
            </button>
            <button disabled={busy} onClick={() => void run(() => call("POST", `${base}/changes/${p!.pid}/discard`, {}))}
              className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-dim hover:text-ink disabled:opacity-40">
              <X size={12} /> Отклонить
            </button>
          </>
        )}
        {p?.status === "applied" && <span className="flex items-center gap-1 text-ok"><Check size={12} /> Локальная копия обновлена</span>}
      </div>
    </div>
  );
}

type Line = { op: " " | "-" | "+"; text: string };

/** Line diff (LCS); long unchanged runs are folded. */
export function diffLines(a: string, b: string): Line[] {
  const x = a.split("\n");
  const y = b.split("\n");
  if (x.length * y.length > 4_000_000) return [...x.map((t) => ({ op: "-" as const, text: t })), ...y.map((t) => ({ op: "+" as const, text: t }))];
  const n = x.length;
  const m = y.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = x[i] === y[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const out: Line[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) out.push({ op: " ", text: x[i++] }), j++;
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) out.push({ op: "-", text: x[i++] });
    else out.push({ op: "+", text: y[j++] });
  }
  while (i < n) out.push({ op: "-", text: x[i++] });
  while (j < m) out.push({ op: "+", text: y[j++] });
  return out;
}

/** `before` is missing for a new record: everything is added. */
function Diff({ before, after }: { before?: string; after: string }) {
  const lines = before === undefined ? after.split("\n").map((text) => ({ op: "+" as const, text })) : diffLines(before, after);
  const near = (k: number) => lines.slice(Math.max(0, k - 2), k + 3).some((l) => l.op !== " ");
  let folded = false;
  return (
    <div className="max-h-72 overflow-auto rounded bg-raised font-mono text-[11px] leading-relaxed">
      {lines.map((l, k) => {
        if (l.op === " " && !near(k)) {
          if (folded) return null;
          folded = true;
          return <div key={k} className="px-2 text-faint">⋯</div>;
        }
        folded = false;
        const tone = l.op === "+" ? "bg-ok/15 text-ok" : l.op === "-" ? "bg-bad/15 text-bad line-through decoration-bad/40" : "text-dim";
        return <div key={k} className={`whitespace-pre-wrap break-words px-2 ${tone}`}>{l.op} {l.text || " "}</div>;
      })}
    </div>
  );
}
