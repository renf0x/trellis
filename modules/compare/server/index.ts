import { createHash } from "node:crypto";
import { HttpError, type DocRecord, type ServerModuleContext, type TestCaseRecord } from "@trellis/core";
import { caseForModel, docForModel, judgeWithChat, judgeWithJev, type PairVerdict } from "./engines.ts";
import { caseDocCandidates, coverageCandidates, docChunks, pairUp, type Candidate, type DocChunk, type Fragment } from "./pairing.ts";
import {
  extractRequirements, judgeCaseDoc, judgeCoverage, judgeQuality,
  type CaseDocStatus, type CaseDocVerdict, type Coverage, type CoverageVerdict, type Criterion, type QualityVerdict,
} from "./stages.ts";

type Engine = "chat" | "jev";
type Kind = "contradicts" | "partial" | "outdated" | "uncertain" | "no-doc" | "no-case" | "error";
type Status = "new" | "accepted" | "rejected";
/** Run order: document quality → requirement coverage → cases without docs → doc ↔ case pairs. Each can be switched off. */
type Stage = "quality" | "coverage" | "casedocs" | "pairs";
const STAGES: Stage[] = ["quality", "coverage", "casedocs", "pairs"];
const STAGE_TITLE: Record<Stage, string> = {
  quality: "Качество документации", coverage: "Покрытие требований", casedocs: "Кейсы без документации", pairs: "Сравнение пар",
};

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
interface DocQuality { docId: string; verdict?: QualityVerdict; error?: string }
interface Requirement {
  id: string;
  docId: string;
  text: string;
  /** Heading and lead-in line the requirement sits under. */
  section?: string;
  /** "unchecked": over the run limit. */
  status: Coverage | "unchecked" | "error";
  /** "no-candidates": no case looked related, so no model checked it. */
  reason?: "no-candidates";
  caseId?: string;
  similarity?: number;
  verdict?: CoverageVerdict;
  error?: string;
}
/** Whether the documentation describes what a test case checks. */
interface CaseDoc {
  caseId: string;
  /** "unchecked": over the run limit. */
  status: CaseDocStatus | "unchecked" | "error";
  /** "no-candidates": no doc fragment looked related, so no model checked it. */
  reason?: "no-candidates";
  /** The fragment that describes the case best, or the most similar one when the case is undocumented. */
  docId?: string;
  heading?: string;
  similarity?: number;
  verdict?: CaseDocVerdict;
  error?: string;
}
interface Run {
  engine: Engine;
  running: boolean;
  startedAt: string;
  finishedAt?: string;
  total: number;
  done: number;
  costUsd: number;
  message: string;
  stages?: Stage[];
  stage?: Stage;
}
interface State {
  run: Run | null;
  findings: Finding[];
  links: Link[];
  quality?: DocQuality[];
  requirements?: Requirement[];
  caseDocs?: CaseDoc[];
  /** When each stage's results were made; a stage switched off keeps the results of an earlier run. */
  stageAt?: Partial<Record<Stage, string>>;
}
/** Past runs are kept in rotating files run-0 … run-19, so a new analysis never wipes an old one. */
interface ArchiveItem { slot: string; seq: number; run: Run; counts: Record<string, number>; findings: number; links: number; coverage?: number | null }
interface ArchiveIndex { seq: number; items: ArchiveItem[] }
const ARCHIVE_SLOTS = 20;

/** Documentation remarks: made by the quality stage or by hand; the tester sets their status. */
type RemarkStatus = "new" | "fixed" | "postponed" | "wontfix";
const REMARK_STATUSES: RemarkStatus[] = ["new", "fixed", "postponed", "wontfix"];
interface DocRemark {
  id: string;
  docId: string;
  criterion: Criterion | "other";
  summary: string;
  suggestion?: string;
  status: RemarkStatus;
  note?: string;
  origin: "analysis" | "manual";
  createdAt: string;
  updatedAt: string;
}
const MAX_REMARKS = 5000;

const hash = (...parts: string[]) => createHash("sha1").update(parts.join("\u0000")).digest("hex").slice(0, 16);
const KIND_ORDER: Kind[] = ["contradicts", "outdated", "partial", "uncertain", "error", "no-doc", "no-case"];
const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

function kindOf(v: PairVerdict, threshold: number): Kind | null {
  if (v.engine === "jev" && v.confidence < threshold) return "uncertain";
  if (v.relation === "contradicts") return "contradicts";
  if (v.actuality === "outdated") return "outdated";
  if (v.relation === "partial") return "partial";
  return null;
}

/** Coverage numbers over checked requirements; partial ones are counted apart, not as covered. */
export function coverageSummary(reqs: Requirement[]) {
  const n = (s: Requirement["status"]) => reqs.filter((r) => r.status === s).length;
  const covered = n("covered");
  const partial = n("partial");
  const notCovered = n("not_covered");
  const checked = covered + partial + notCovered;
  return {
    total: reqs.length, checked, covered, partial, notCovered, unchecked: n("unchecked"), errors: n("error"),
    percent: checked ? Math.round((covered / checked) * 100) : null,
    partialPercent: checked ? Math.round((partial / checked) * 100) : null,
  };
}

export function caseDocSummary(items: CaseDoc[]) {
  const n = (s: CaseDoc["status"]) => items.filter((x) => x.status === s).length;
  return {
    total: items.length, documented: n("documented"), partial: n("partial"), undocumented: n("undocumented"),
    unchecked: n("unchecked"), errors: n("error"),
  };
}

/** Runs `fn` over `items` with `n` workers until done or aborted. */
async function pool<T>(items: T[], n: number, signal: AbortSignal, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length && !signal.aborted) await fn(items[next++]);
  }));
}

// Money, auth or a Cloudflare block of the whole network ("Анализ остановлен") won't pass on the next item.
const fatal = (err: unknown) => /402|401|не хватает|выключен|Нет ключа|Анализ остановлен/.test((err as Error).message);

export function register(ctx: ServerModuleContext) {
  let state: State = { run: null, findings: [], links: [] };
  const loaded = ctx.files.read<State>("state").then((s) => {
    if (s) state = { ...s, run: s.run ? { ...s.run, running: false } : null };
  });
  const save = () => ctx.files.write("state", state);
  // Same engine + same texts → same verdict: re-runs don't pay twice.
  let cache: Record<string, unknown> = {};
  const cacheLoaded = ctx.files.read<Record<string, unknown>>("cache").then((c) => void (cache = c ?? {}));
  let abort: AbortController | null = null;

  let remarks: DocRemark[] = [];
  const remarksLoaded = ctx.files.read<{ items: DocRemark[] }>("remarks").then((r) => void (remarks = r?.items ?? []));
  const saveRemarks = () => ctx.files.write("remarks", { items: remarks });

  let archive: ArchiveIndex = { seq: 0, items: [] };
  const countKinds = (fs: Finding[]) => {
    const counts: Record<string, number> = {};
    for (const f of fs) if (f.status !== "rejected") counts[f.kind] = (counts[f.kind] ?? 0) + 1;
    return counts;
  };
  const archiveRun = async (s: State) => {
    if (!s.run) return;
    const seq = archive.seq + 1;
    const slot = `run-${seq % ARCHIVE_SLOTS}`;
    await ctx.files.write(slot, s);
    const item: ArchiveItem = {
      slot, seq, run: s.run, counts: countKinds(s.findings), findings: s.findings.length, links: s.links.length,
      coverage: s.requirements ? coverageSummary(s.requirements).percent : undefined,
    };
    archive = { seq, items: [item, ...archive.items.filter((x) => x.slot !== slot)].slice(0, ARCHIVE_SLOTS) };
    await ctx.files.write("runs", archive);
  };
  // Results from before the archive existed become its first entry.
  const archiveLoaded = Promise.all([loaded, ctx.files.read<ArchiveIndex>("runs")]).then(async ([, a]) => {
    if (a) archive = a;
    else if (state.run?.finishedAt) await archiveRun(state);
  });
  /** The latest state, or an archived one for `?run=run-3`. */
  const stateOf = async (slot?: string): Promise<State> => {
    await loaded;
    if (!slot) return state;
    await archiveLoaded;
    const s = archive.items.some((x) => x.slot === slot) ? await ctx.files.read<State>(slot) : null;
    if (!s) throw new HttpError(404, "Запуск не найден в архиве");
    return s;
  };

  const load = async () => {
    const [docs, cases] = await Promise.all([ctx.data.docs(), ctx.data.cases()]);
    return { docs, cases, docById: new Map(docs.map((d) => [d.id, d])), caseById: new Map(cases.map((c) => [c.id, c])) };
  };

  ctx.route("GET", "/status", async () => {
    await loaded;
    const [{ docs, cases }, analysis, chat] = await Promise.all([load(), ctx.llm.analysis(), ctx.llm.chatModel()]);
    const p = pairUp(docs, cases);
    return {
      run: state.run && { ...state.run }, // a snapshot: the live run object may finish while the rest is read
      engines: { chat, jev: analysis.jev },
      data: { docs: docs.length, cases: cases.length, pairs: p.pairs.length, orphanCases: p.orphanCases.length, uncoveredDocs: p.uncoveredDocs.length },
      counts: countKinds(state.findings),
      links: state.links.length,
      quality: state.quality?.length ?? 0,
      coverage: state.requirements ? coverageSummary(state.requirements) : null,
      caseDocs: state.caseDocs ? caseDocSummary(state.caseDocs) : null,
      stageAt: state.stageAt ?? {},
    };
  });

  ctx.route("POST", "/run", async ({ body }) => {
    await Promise.all([loaded, cacheLoaded, remarksLoaded]);
    if (state.run?.running) throw new HttpError(409, "Анализ уже идёт");
    const b = (body ?? {}) as Record<string, unknown>;
    const engine: Engine = b.engine === "jev" ? "jev" : "chat";
    const limit = Math.min(Math.max(Number(b.limit) || 50, 1), 2000);
    const explain = b.explain !== false;
    const want = (b.stages ?? {}) as Partial<Record<Stage, unknown>>;
    const stages = STAGES.filter((s) => want[s] !== false);
    if (!stages.length) throw new HttpError(400, "Включите хотя бы один этап");
    const [analysis, chat] = await Promise.all([ctx.llm.analysis(), ctx.llm.chatModel()]);
    if (engine === "jev" && !analysis.jev.enabled) throw new HttpError(409, "Jev выключен: включите его в «Настройки → Анализ»");
    if (engine === "chat" && !chat) throw new HttpError(409, "Для основного чата не выбрана модель: «Настройки»");

    const { docs, cases, docById, caseById } = await load();
    if (!docs.length) throw new HttpError(409, "Нет документации: загрузите её из источника");
    if (stages.some((s) => s !== "quality") && !cases.length) throw new HttpError(409, "Для покрытия и сравнения нужны тест-кейсы: загрузите их из источника");
    const p = cases.length ? pairUp(docs, cases) : { pairs: [], orphanCases: [], uncoveredDocs: docs.map((d) => d.id) };
    const runAt = new Date().toISOString();

    // Docs with matching cases first: they matter most for testing.
    const paired = new Set(p.pairs.map((x) => x.docId));
    const ordered = [...docs.filter((d) => paired.has(d.id)), ...docs.filter((d) => !paired.has(d.id))];

    // Quality: one call per document.
    const qualityDocs = stages.includes("quality") ? ordered.slice(0, limit) : [];

    // Coverage: requirements from the text, candidate cases by similarity of steps and by the document's pairs;
    // with no candidate at all it is uncovered for free, and the item says no model checked it.
    const requirements: Requirement[] = [];
    const candidates = new Map<string, Candidate[]>();
    if (stages.includes("coverage")) {
      for (const d of ordered) {
        for (const x of extractRequirements(d)) requirements.push({ id: hash("req", d.id, x.text), docId: d.id, ...x, status: "unchecked" });
      }
      const top = coverageCandidates(requirements, cases, p.pairs);
      requirements.forEach((r, i) => {
        if (top[i].length) candidates.set(r.id, top[i]);
        else Object.assign(r, { status: "not_covered", reason: "no-candidates" });
      });
    }
    const toJudge = requirements.filter((r) => candidates.has(r.id)).slice(0, limit);
    // Cases without documentation: doc fragments by similarity; none at all means undocumented for free.
    // Cases with no paired document go first, they are the likeliest to be undocumented.
    const caseDocs: CaseDoc[] = [];
    const fragments = new Map<string, Fragment[]>();
    let chunks: DocChunk[] = [];
    if (stages.includes("casedocs")) {
      chunks = docChunks(docs);
      const orphan = new Set(p.orphanCases);
      const byCase = [...cases.filter((c) => orphan.has(c.id)), ...cases.filter((c) => !orphan.has(c.id))];
      const top = caseDocCandidates(byCase, chunks);
      byCase.forEach((c, i) => {
        const best = top[i][0];
        if (!best) return void caseDocs.push({ caseId: c.id, status: "undocumented", reason: "no-candidates" });
        fragments.set(c.id, top[i]);
        caseDocs.push({ caseId: c.id, status: "unchecked", docId: chunks[best.chunk].docId, heading: chunks[best.chunk].heading, similarity: best.similarity });
      });
    }
    const caseDocsToJudge = caseDocs.filter((x) => fragments.has(x.caseId)).slice(0, limit);
    const pairs = stages.includes("pairs") ? p.pairs.slice(0, limit) : [];

    const run: Run = {
      engine, running: true, startedAt: runAt, stages, stage: stages[0],
      total: qualityDocs.length + toJudge.length + caseDocsToJudge.length + pairs.length, done: 0, costUsd: 0, message: STAGE_TITLE[stages[0]],
    };
    abort = new AbortController();
    const signal = abort.signal;
    const prev = state;
    state = { ...state, run };
    const threshold = analysis.jev.threshold;
    const workers = 2; // more parallel Jev calls meet Cloudflare blocks on OpenRouter
    const cached = async <T extends { costUsd: number }>(key: string, f: () => Promise<T>): Promise<T> => {
      if (cache[key]) return cache[key] as T;
      const v = await f();
      run.costUsd += v.costUsd;
      cache[key] = v;
      return v;
    };
    let stopReason = "";
    const failed = (err: unknown) => {
      if (!fatal(err) || signal.aborted) return;
      stopReason = (err as Error).message;
      abort?.abort();
    };

    void (async () => {
      const next: State = { run, findings: prev.findings, links: prev.links, quality: prev.quality, requirements: prev.requirements, caseDocs: prev.caseDocs, stageAt: { ...prev.stageAt } };

      if (stages.includes("quality")) {
        run.stage = "quality";
        run.message = STAGE_TITLE.quality;
        const quality: DocQuality[] = [];
        await pool(qualityDocs, workers, signal, async (d) => {
          try {
            const v = await cached(hash("quality", engine, String(explain && !!chat), docForModel(d)),
              () => judgeQuality(ctx.llm, d, { engine, chat: explain && !!chat, signal }));
            quality.push({ docId: d.id, verdict: v });
          } catch (err) {
            if (!signal.aborted) quality.push({ docId: d.id, error: (err as Error).message });
            failed(err);
          }
          run.done++;
        });
        quality.sort((a, b) => (a.verdict?.overall ?? 2) - (b.verdict?.overall ?? 2));
        next.quality = quality;
        next.stageAt!.quality = runAt;
        addRemarks(quality);
      }

      if (stages.includes("coverage") && !signal.aborted) {
        run.stage = "coverage";
        run.message = STAGE_TITLE.coverage;
        await pool(toJudge, workers, signal, async (r) => {
          const list = candidates.get(r.id)!;
          const d = docById.get(r.docId)!;
          const cs = list.map((x) => caseById.get(x.caseId)!).filter(Boolean);
          try {
            const chatToo = engine === "jev" && explain && !!chat;
            const v = await cached(hash("coverage", engine, String(chatToo), String(threshold), r.text, r.section ?? "", d.title, ...cs.map(caseForModel)),
              () => judgeCoverage(ctx.llm, r.text, d, cs, { engine, section: r.section, chat: chatToo, threshold, signal }));
            r.status = v.status;
            r.verdict = v;
            r.caseId = v.caseId;
            r.similarity = list.find((x) => x.caseId === v.caseId)?.similarity;
          } catch (err) {
            if (!signal.aborted) Object.assign(r, { status: "error", error: (err as Error).message });
            failed(err);
          }
          run.done++;
        });
        next.requirements = requirements;
        next.stageAt!.coverage = runAt;
      }

      if (stages.includes("casedocs") && !signal.aborted) {
        run.stage = "casedocs";
        run.message = STAGE_TITLE.casedocs;
        const chatToo = engine === "jev" && explain && !!chat;
        await pool(caseDocsToJudge, workers, signal, async (x) => {
          const c = caseById.get(x.caseId)!;
          const list = fragments.get(x.caseId)!;
          const frags = list.map((f) => {
            const ch = chunks[f.chunk];
            return { title: `${docById.get(ch.docId)?.title ?? ch.docId}${ch.heading ? ` › ${ch.heading}` : ""}`, text: ch.text };
          });
          try {
            const v = await cached(hash("casedocs", engine, String(chatToo), String(threshold), caseForModel(c), ...frags.map((f) => `${f.title}\n${f.text}`)),
              () => judgeCaseDoc(ctx.llm, c, frags, { engine, chat: chatToo, threshold, signal }));
            const best = chunks[list[v.fragment ?? 0].chunk];
            Object.assign(x, { status: v.status, verdict: v, docId: best.docId, heading: best.heading, similarity: list[v.fragment ?? 0].similarity });
          } catch (err) {
            if (!signal.aborted) Object.assign(x, { status: "error", error: (err as Error).message });
            failed(err);
          }
          run.done++;
        });
        next.caseDocs = caseDocs;
        next.stageAt!.casedocs = runAt;
      }

      if (stages.includes("pairs") && !signal.aborted) {
        run.stage = "pairs";
        run.message = STAGE_TITLE.pairs;
        const statusOf = new Map(prev.findings.map((f) => [f.id, f.status]));
        const findings: Finding[] = [];
        const links: Link[] = [];
        const add = (f: Omit<Finding, "status" | "runAt">) => findings.push({ ...f, status: statusOf.get(f.id) ?? "new", runAt });
        for (const id of p.orphanCases) add({ id: hash("no-doc", id), kind: "no-doc", caseId: id });
        for (const id of p.uncoveredDocs) add({ id: hash("no-case", id), kind: "no-case", docId: id });
        await pool(pairs, workers, signal, async (pair) => {
          const d = docById.get(pair.docId)!;
          const c = caseById.get(pair.caseId)!;
          const id = hash("pair", pair.caseId, pair.docId);
          try {
            // Same key as before stages existed, so earlier verdicts stay cached.
            const v = await cached(hash(engine, String(explain && !!chat), docForModel(d), caseForModel(c)), () => engine === "jev"
              ? judgeWithJev(ctx.llm, d, c, { threshold, chat: explain && !!chat, signal })
              : judgeWithChat(ctx.llm, d, c, signal));
            const kind = kindOf(v, threshold);
            if (kind) add({ id, kind, caseId: c.id, docId: d.id, similarity: pair.similarity, verdict: v });
            else if (v.relation !== "unrelated") links.push({ caseId: c.id, docId: d.id, confidence: v.confidence, engine: v.engine });
          } catch (err) {
            if (!signal.aborted) add({ id, kind: "error", caseId: c.id, docId: d.id, similarity: pair.similarity, error: (err as Error).message });
            failed(err);
          }
          run.done++;
        });
        findings.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (b.similarity ?? 0) - (a.similarity ?? 0));
        next.findings = findings;
        next.links = links;
        next.stageAt!.pairs = runAt;
      }

      run.running = false;
      run.stage = undefined;
      run.finishedAt = new Date().toISOString();
      const parts: string[] = [];
      if (stages.includes("quality")) parts.push(`документов оценено: ${next.quality?.length ?? 0}`);
      if (stages.includes("coverage") && next.requirements === requirements) {
        const s = coverageSummary(requirements);
        parts.push(`требований: ${s.total}, покрыто ${s.percent ?? 0}% проверенных`);
      }
      if (stages.includes("casedocs") && next.caseDocs === caseDocs) {
        const s = caseDocSummary(caseDocs);
        parts.push(`кейсов без документации: ${s.undocumented}, частично: ${s.partial}`);
      }
      if (stages.includes("pairs") && next.stageAt?.pairs === runAt) parts.push(`находок: ${next.findings.length}, связей: ${next.links.length}`);
      run.message = `${signal.aborted ? `Остановлено. ${stopReason ? `${stopReason} ` : ""}` : ""}${parts.join("; ") || "Ничего не проверено"}`;
      state = next;
      await Promise.all([save(), ctx.files.write("cache", cache), saveRemarks()]);
      await archiveLoaded;
      await archiveRun(state);
      ctx.log(`compare ${engine} [${stages.join(",")}]: ${run.done}/${run.total} cost=$${run.costUsd.toFixed(6)}`);
    })();
    return run;
  });

  /** Remarks from the quality stage join the list; ones already there keep the tester's status. */
  function addRemarks(quality: DocQuality[]) {
    const now = new Date().toISOString();
    const known = new Set(remarks.map((r) => r.id));
    for (const q of quality) {
      for (const r of q.verdict?.remarks ?? []) {
        const id = hash("remark", q.docId, r.criterion, r.summary.toLowerCase().replace(/\s+/g, " "));
        if (known.has(id)) continue;
        known.add(id);
        remarks.push({ id, docId: q.docId, criterion: r.criterion, summary: r.summary, suggestion: r.suggestion, status: "new", origin: "analysis", createdAt: now, updatedAt: now });
      }
    }
    if (remarks.length > MAX_REMARKS) {
      // Drop the oldest closed ones first; open remarks are the tester's work list.
      const open = remarks.filter((r) => r.status === "new" || r.status === "postponed");
      const closed = remarks.filter((r) => !(r.status === "new" || r.status === "postponed"));
      remarks = [...open, ...closed.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))].slice(0, MAX_REMARKS);
    }
  }

  ctx.route("POST", "/stop", async () => {
    abort?.abort();
    return { ok: true };
  });

  const enrich = async (all: Finding[], query: Record<string, string | undefined>) => {
    const { docById, caseById } = await load();
    return all
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
  };
  const docRef = (d?: DocRecord) => (d ? { id: d.id, title: d.title, path: `${d.container}${d.path}`, url: d.url } : undefined);
  const caseRef = (c?: TestCaseRecord) => (c ? { id: c.id, externalId: c.externalId, title: c.title, url: c.url } : undefined);

  ctx.route("GET", "/findings", async ({ query }) => {
    await loaded;
    return { items: await enrich(state.findings, query), total: state.findings.length };
  });

  ctx.route("GET", "/runs", async () => {
    await archiveLoaded;
    return { items: archive.items };
  });

  // A past run, read only: its findings with the statuses they had when it finished.
  ctx.route("GET", "/runs/:slot", async ({ params, query }) => {
    const s = await stateOf(params.slot);
    return { run: s.run, items: await enrich(s.findings, query), total: s.findings.length, links: s.links.length };
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
  // `?run=run-3` takes the finding from an archived run.
  ctx.route("GET", "/findings/:id/context", async ({ params, query }) => {
    const f = (await stateOf(query.run)).findings.find((x) => x.id === params.id);
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
    // Trellis ids let the chat propose an exact change (trellis-change block) to the right record.
    if (d) lines.push("", `## Документация (id: ${d.id})`, docForModel(d));
    if (c) lines.push("", `## Тест-кейс (id: ${c.id})`, caseForModel(c));
    return { title: c ? `#${c.externalId} ${c.title}` : d?.title ?? f.kind, text: lines.join("\n") };
  });

  // ── Quality and coverage results ──

  ctx.route("GET", "/quality", async ({ query }) => {
    const s = await stateOf(query.run);
    const { docById } = await load();
    return { at: s.stageAt?.quality ?? null, items: (s.quality ?? []).map((q) => ({ ...q, doc: docRef(docById.get(q.docId)) })) };
  });

  ctx.route("GET", "/coverage", async ({ query }) => {
    const s = await stateOf(query.run);
    const reqs = s.requirements ?? [];
    const { docById, caseById } = await load();
    const byDoc = new Map<string, Requirement[]>();
    for (const r of reqs) byDoc.set(r.docId, [...(byDoc.get(r.docId) ?? []), r]);
    const docs = [...byDoc].map(([docId, rs]) => ({ doc: docRef(docById.get(docId)) ?? { id: docId, title: docId, path: "" }, ...coverageSummary(rs) }))
      .sort((a, b) => (a.percent ?? 101) - (b.percent ?? 101) || b.total - a.total);
    const items = reqs
      .filter((r) => !query.status || r.status === query.status)
      .filter((r) => !query.docId || r.docId === query.docId)
      .map((r) => ({ ...r, doc: docRef(docById.get(r.docId)), case: caseRef(r.caseId ? caseById.get(r.caseId) : undefined) }));
    return { at: s.stageAt?.coverage ?? null, summary: coverageSummary(reqs), docs, items };
  });

  ctx.route("GET", "/requirements/:id/context", async ({ params, query }) => {
    const r = (await stateOf(query.run)).requirements?.find((x) => x.id === params.id);
    if (!r) throw new HttpError(404, "Требование не найдено");
    const { docById, caseById } = await load();
    const d = docById.get(r.docId);
    const c = r.caseId ? caseById.get(r.caseId) : undefined;
    const label: Record<Requirement["status"], string> = {
      covered: "покрыто", partial: "покрыто частично", not_covered: "не покрыто", unchecked: "не проверено", error: "ошибка проверки",
    };
    const lines = [`Требование из документации: «${r.text}»`];
    if (r.section) lines.push(`Раздел: ${r.section}`);
    lines.push(`Покрытие тест-кейсами: ${label[r.status]}${r.reason === "no-candidates" ? " (похожих кейсов не нашлось, модель не проверяла)" : ""}.`);
    if (r.verdict?.comment) lines.push(`Комментарий: ${r.verdict.comment}`);
    if (d) lines.push("", `## Документация (id: ${d.id})`, docForModel(d));
    if (c) lines.push("", `## Ближайший тест-кейс (id: ${c.id})`, caseForModel(c));
    return { title: `Требование: ${r.text.slice(0, 60)}`, text: lines.join("\n") };
  });

  // Cases the documentation does not describe; testcases-view shows them as «Тесты без документации».
  ctx.route("GET", "/case-docs", async ({ query }) => {
    const s = await stateOf(query.run);
    const { docById, caseById } = await load();
    const items = (s.caseDocs ?? []).filter((x) => caseById.has(x.caseId)); // cases deleted since the run drop out
    return {
      at: s.stageAt?.casedocs ?? null,
      summary: caseDocSummary(items),
      items: items
        .filter((x) => !query.status || x.status === query.status)
        .map((x) => ({ ...x, case: caseRef(caseById.get(x.caseId)), doc: docRef(x.docId ? docById.get(x.docId) : undefined) })),
    };
  });

  ctx.route("GET", "/case-docs/:caseId/context", async ({ params, query }) => {
    const x = (await stateOf(query.run)).caseDocs?.find((i) => i.caseId === params.caseId);
    if (!x) throw new HttpError(404, "Кейс не проверялся на документацию");
    const { docById, caseById } = await load();
    const c = caseById.get(x.caseId);
    const d = x.docId ? docById.get(x.docId) : undefined;
    const label: Record<CaseDoc["status"], string> = {
      documented: "описан в документации", partial: "описан частично", undocumented: "не описан в документации", unchecked: "не проверен", error: "ошибка проверки",
    };
    const lines = [`Проверка «Тесты без документации»: кейс ${label[x.status]}${x.reason === "no-candidates" ? " (похожих фрагментов документации не нашлось, модель не проверяла)" : ""}.`];
    if (x.verdict?.comment) lines.push(`Комментарий: ${x.verdict.comment}`);
    if (c) lines.push("", `## Тест-кейс (id: ${c.id})`, caseForModel(c));
    if (d) lines.push("", `## Ближайшая документация (id: ${d.id})${x.heading ? `, раздел «${x.heading}»` : ""}`, docForModel(d));
    return { title: c ? `#${c.externalId} ${c.title}` : x.caseId, text: lines.join("\n") };
  });

  // ── Documentation remarks ──

  ctx.route("GET", "/remarks", async ({ query }) => {
    await remarksLoaded;
    const { docById } = await load();
    const items = remarks
      .filter((r) => !query.docId || r.docId === query.docId)
      .filter((r) => !query.status || r.status === query.status)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((r) => ({ ...r, doc: docRef(docById.get(r.docId)) }));
    const counts = Object.fromEntries(REMARK_STATUSES.map((s) => [s, remarks.filter((r) => (!query.docId || r.docId === query.docId) && r.status === s).length]));
    return { items, counts };
  });

  ctx.route("POST", "/remarks", async ({ body }) => {
    await remarksLoaded;
    const b = (body ?? {}) as Record<string, unknown>;
    const docId = str(b.docId, 300);
    const summary = str(b.summary, 2000);
    if (!docId || !summary) throw new HttpError(400, "Нужны docId и текст замечания");
    if (!(await load()).docById.has(docId)) throw new HttpError(404, "Документ не найден");
    const now = new Date().toISOString();
    const r: DocRemark = {
      id: hash("remark-manual", docId, summary, now), docId, summary, criterion: "other",
      suggestion: str(b.suggestion, 2000) || undefined, status: "new", origin: "manual", createdAt: now, updatedAt: now,
    };
    remarks.push(r);
    await saveRemarks();
    return r;
  });

  ctx.route("POST", "/remarks/:id", async ({ params, body }) => {
    await remarksLoaded;
    const r = remarks.find((x) => x.id === params.id);
    if (!r) throw new HttpError(404, "Замечание не найдено");
    const b = (body ?? {}) as Record<string, unknown>;
    if (b.status !== undefined) {
      if (!REMARK_STATUSES.includes(b.status as RemarkStatus)) throw new HttpError(400, `status: ${REMARK_STATUSES.join(" | ")}`);
      r.status = b.status as RemarkStatus;
    }
    if (b.note !== undefined) r.note = str(b.note, 2000) || undefined;
    r.updatedAt = new Date().toISOString();
    await saveRemarks();
    return r;
  });

  const removeRemark = async ({ params }: { params: Record<string, string> }) => {
    await remarksLoaded;
    const r = remarks.find((x) => x.id === params.id);
    if (!r) throw new HttpError(404, "Замечание не найдено");
    if (r.origin !== "manual") throw new HttpError(409, "Замечание анализа не удаляется: поставьте статус «Не требует исправления»");
    remarks = remarks.filter((x) => x !== r);
    await saveRemarks();
    return { ok: true };
  };
  ctx.route("DELETE", "/remarks/:id", removeRemark);
  // The module UI api has no DELETE.
  ctx.route("POST", "/remarks/:id/delete", removeRemark);
}
