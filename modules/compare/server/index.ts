import { createHash } from "node:crypto";
import { HttpError, type DocRecord, type ServerModuleContext, type TestCaseRecord } from "@trellis/core";
import { caseForModel, docForModel, isProblem, judgeWithChat, judgeWithJev, type PairVerdict } from "./engines.ts";
import { pairUp } from "./pairing.ts";

type Engine = "chat" | "jev";
type Kind = "contradicts" | "partial" | "outdated" | "uncertain" | "no-doc" | "no-case" | "error";
type Status = "new" | "accepted" | "rejected";

interface Finding {
  id: string;
  kind: Kind;
  caseId?: string;
  docId?: string;
  similarity?: number;
  verdict?: PairVerdict;
  error?: string;
  status: Status;
  runAt: string;
}
interface Link { caseId: string; docId: string; confidence: number; engine: PairVerdict["engine"] }
interface Run {
  engine: Engine;
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  costUsd: number;
  message: string;
}
interface State { run: Run | null; findings: Finding[]; links: Link[] }

const hash = (...parts: string[]) => createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
const KIND_ORDER: Kind[] = ["contradicts", "outdated", "partial", "uncertain", "error", "no-doc", "no-case"];

function kindOf(v: PairVerdict, threshold: number): Kind | null {
  if (v.engine === "jev" && v.confidence < threshold) return "uncertain";
  if (v.relation === "contradicts") return "contradicts";
  if (v.actuality === "outdated") return "outdated";
  if (v.relation === "partial") return "partial";
  return null;
}

export function register(ctx: ServerModuleContext) {
  let state: State = { run: null, findings: [], links: [] };
  const loaded = ctx.files.read<State>("state").then((s) => {
    if (s) state = { ...s, run: s.run ? { ...s.run, running: false } : null };
  });
  const save = () => ctx.files.write("state", state);
  // Same engine + same texts → same verdict: re-runs don't pay twice.
  let cache: Record<string, PairVerdict> = {};
  const cacheLoaded = ctx.files.read<Record<string, PairVerdict>>("cache").then((c) => void (cache = c ?? {}));
  let abort: AbortController | null = null;

  const load = async () => {
    const [docs, cases] = await Promise.all([ctx.data.docs(), ctx.data.cases()]);
    return { docs, cases, docById: new Map(docs.map((d) => [d.id, d])), caseById: new Map(cases.map((c) => [c.id, c])) };
  };

  ctx.route("GET", "/status", async () => {
    await loaded;
    const [{ docs, cases }, analysis, chat] = await Promise.all([load(), ctx.llm.analysis(), ctx.llm.chatModel()]);
    const p = pairUp(docs, cases);
    const counts: Record<string, number> = {};
    for (const f of state.findings) if (f.status !== "rejected") counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    return {
      run: state.run,
      engines: { chat, jev: analysis.jev },
      data: { docs: docs.length, cases: cases.length, pairs: p.pairs.length, orphanCases: p.orphanCases.length, uncoveredDocs: p.uncoveredDocs.length },
      counts,
      links: state.links.length,
    };
  });

  ctx.route("POST", "/run", async ({ body }) => {
    await loaded;
    await cacheLoaded;
    if (state.run?.running) throw new HttpError(409, "Анализ уже идёт");
    const b = (body ?? {}) as Record<string, unknown>;
    const engine: Engine = b.engine === "jev" ? "jev" : "chat";
    const limit = Math.min(Math.max(Number(b.limit) || 50, 1), 2000);
    const explain = b.explain !== false;
    const [analysis, chat] = await Promise.all([ctx.llm.analysis(), ctx.llm.chatModel()]);
    if (engine === "jev" && !analysis.jev.enabled) throw new HttpError(409, "Jev выключен: включите его в «Настройки → Анализ»");
    if (engine === "chat" && !chat) throw new HttpError(409, "Для основного чата не выбрана модель: «Настройки»");

    const { docs, cases, docById, caseById } = await load();
    if (!docs.length || !cases.length) throw new HttpError(409, "Нужны и документация, и тест-кейсы: загрузите их из источника");
    const p = pairUp(docs, cases);
    const pairs = p.pairs.slice(0, limit);
    const runAt = new Date().toISOString();
    const run: Run = { engine, running: true, startedAt: runAt, total: pairs.length, done: 0, costUsd: 0, message: "Анализ пар" };
    const prev = new Map(state.findings.map((f) => [f.id, f.status]));
    const findings: Finding[] = [];
    const links: Link[] = [];
    const add = (f: Omit<Finding, "status" | "runAt">) => findings.push({ ...f, status: prev.get(f.id) ?? "new", runAt });
    for (const id of p.orphanCases) add({ id: hash("no-doc", id), kind: "no-doc", caseId: id });
    for (const id of p.uncoveredDocs) add({ id: hash("no-case", id), kind: "no-case", docId: id });

    abort = new AbortController();
    const signal = abort.signal;
    state.run = run;
    void (async () => {
      const threshold = analysis.jev.threshold;
      const judge = async (d: DocRecord, c: TestCaseRecord) => {
        const key = hash(engine, String(explain && !!chat), docForModel(d), caseForModel(c));
        if (cache[key]) return cache[key];
        const v = engine === "jev"
          ? await judgeWithJev(ctx.llm, d, c, { threshold, chat: explain && !!chat, signal })
          : await judgeWithChat(ctx.llm, d, c, signal);
        run.costUsd += v.costUsd;
        cache[key] = v;
        return v;
      };
      let next = 0;
      const worker = async () => {
        while (next < pairs.length && !signal.aborted) {
          const pair = pairs[next++];
          const d = docById.get(pair.docId)!;
          const c = caseById.get(pair.caseId)!;
          const id = hash("pair", pair.caseId, pair.docId);
          try {
            const v = await judge(d, c);
            const kind = kindOf(v, threshold);
            if (kind) add({ id, kind, caseId: c.id, docId: d.id, similarity: pair.similarity, verdict: v });
            else if (v.relation !== "unrelated") links.push({ caseId: c.id, docId: d.id, confidence: v.confidence, engine: v.engine });
          } catch (err) {
            if (signal.aborted) break;
            add({ id, kind: "error", caseId: c.id, docId: d.id, similarity: pair.similarity, error: (err as Error).message });
            // Money or auth problems won't fix themselves on the next pair.
            if (/402|401|не хватает|выключен|Нет ключа/.test((err as Error).message)) abort?.abort();
          }
          run.done++;
        }
      };
      await Promise.all(Array.from({ length: engine === "jev" ? 4 : 2 }, worker));
      findings.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.similarity ?? 0) - (a.similarity ?? 0));
      run.running = false;
      run.finishedAt = new Date().toISOString();
      const stopped = signal.aborted ? "Остановлено. " : "";
      run.message = `${stopped}Проверено пар: ${run.done} из ${run.total}, находок: ${findings.length}, связей подтверждено: ${links.length}`;
      state = { run, findings, links };
      await Promise.all([save(), ctx.files.write("cache", cache)]);
      ctx.log(`compare ${engine}: pairs=${run.done}/${run.total} findings=${findings.length} cost=$${run.costUsd.toFixed(6)}`);
    })();
    return run;
  });

  ctx.route("POST", "/stop", async () => {
    abort?.abort();
    return { ok: true };
  });

  ctx.route("GET", "/findings", async ({ query }) => {
    await loaded;
    const { docById, caseById } = await load();
    const items = state.findings
      .filter((f) => (query.status ? f.status === query.status : f.status !== "rejected"))
      .filter((f) => !query.kind || f.kind === query.kind)
      .map((f) => {
        const c = f.caseId ? caseById.get(f.caseId) : undefined;
        const d = f.docId ? docById.get(f.docId) : undefined;
        return {
          ...f,
          case: c ? { id: c.id, externalId: c.externalId, title: c.title, url: c.url } : undefined,
          doc: d ? { id: d.id, title: d.title, path: `${d.container}${d.path}`, url: d.url } : undefined,
        };
      });
    return { items, total: state.findings.length };
  });

  ctx.route("POST", "/findings/:id", async ({ params, body }) => {
    await loaded;
    const f = state.findings.find((x) => x.id === params.id);
    if (!f) throw new HttpError(404, "Находка не найдена: запустите анализ заново");
    const s = (body as Record<string, unknown> | undefined)?.status;
    if (s !== "new" && s !== "accepted" && s !== "rejected") throw new HttpError(400, "status: new | accepted | rejected");
    f.status = s;
    await save();
    return f;
  });

  // Full texts for the main chat, so follow-up questions are answered from the sources, not from memory.
  ctx.route("GET", "/findings/:id/context", async ({ params }) => {
    await loaded;
    const f = state.findings.find((x) => x.id === params.id);
    if (!f) throw new HttpError(404, "Находка не найдена");
    const { docById, caseById } = await load();
    const d = f.docId ? docById.get(f.docId) : undefined;
    const c = f.caseId ? caseById.get(f.caseId) : undefined;
    const v = f.verdict;
    const lines = [`Находка анализа «${f.kind}»${v ? ` (движок ${v.engine}, уверенность ${Math.round(v.confidence * 100)}%)` : ""}.`];
    if (v?.explanation) lines.push(`Объяснение: ${v.explanation}`);
    for (const i of v?.issues ?? []) lines.push(`- ${i.summary}${i.suggestion ? ` → ${i.suggestion}` : ""}`);
    if (v?.jev) lines.push(`Вероятности Jev (relation): ${JSON.stringify(v.jev.relation)}`);
    if (f.error) lines.push(`Ошибка: ${f.error}`);
    if (d) lines.push("", "## Документация", docForModel(d));
    if (c) lines.push("", "## Тест-кейс", caseForModel(c));
    return { title: c ? `#${c.externalId} ${c.title}` : d?.title ?? f.kind, text: lines.join("\n") };
  });
}
