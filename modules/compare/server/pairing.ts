// Cheap candidate pairing before any model call: TF-IDF cosine over crude stems, via an inverted index,
// so thousands of docs and cases pair in well under a second. Models then judge only the top pairs.
import type { DocRecord, TestCaseRecord } from "@trellis/core";

const STOP = new Set([
  "the", "and", "for", "with", "that", "this", "from", "are", "was", "not", "you", "can", "will", "has", "have", "into",
  "что", "как", "для", "при", "его", "она", "они", "это", "или", "если", "чтобы", "также", "того", "быть", "есть",
  "нет", "все", "без", "под", "над", "так", "уже", "только", "после", "перед", "между", "шаг", "step",
]);

/** Lowercase words of 3+ letters, cut to 6 chars: a rough stemmer that works for Russian and English alike. */
export function terms(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().replace(/ё/g, "е").match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    out.push(w.slice(0, 6));
  }
  return out;
}

export const docText = (d: DocRecord) => `${d.title}\n${d.path}\n${d.content}`;
export const caseText = (c: TestCaseRecord) =>
  `${c.title}\n${c.suites.join("\n")}\n${c.steps.map((s) => `${s.action}\n${s.expected}`).join("\n")}`;

type Vec = Map<string, number>;

function tf(ts: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of ts) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function weigh(counts: Map<string, number>, idf: Map<string, number>): Vec {
  const v: Vec = new Map();
  let norm = 0;
  for (const [t, n] of counts) {
    const w = (1 + Math.log(n)) * (idf.get(t) ?? 0);
    if (w > 0) (v.set(t, w), (norm += w * w));
  }
  norm = Math.sqrt(norm) || 1;
  for (const [t, w] of v) v.set(t, w / norm);
  return v;
}

/** For each query text, the indexes of the `k` most similar target texts (cosine ≥ `min`), best first. */
export function similar(queries: string[], targets: string[], k: number, min: number): { target: number; similarity: number }[][] {
  const qCounts = queries.map((t) => tf(terms(t)));
  const tCounts = targets.map((t) => tf(terms(t)));
  const df = new Map<string, number>();
  for (const m of [...qCounts, ...tCounts]) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = qCounts.length + tCounts.length;
  const idf = new Map([...df].map(([t, c]) => [t, Math.log((n + 1) / (c + 1)) + 1] as const));
  const index = new Map<string, { target: number; w: number }[]>();
  tCounts.forEach((m, target) => {
    for (const [t, w] of weigh(m, idf)) {
      let list = index.get(t);
      if (!list) index.set(t, (list = []));
      list.push({ target, w });
    }
  });
  return qCounts.map((m) => {
    const score = new Map<number, number>();
    for (const [t, w] of weigh(m, idf)) for (const p of index.get(t) ?? []) score.set(p.target, (score.get(p.target) ?? 0) + w * p.w);
    return [...score].filter(([, s]) => s >= min).sort((a, b) => b[1] - a[1]).slice(0, k)
      .map(([target, s]) => ({ target, similarity: Math.round(s * 1000) / 1000 }));
  });
}

export interface Pair { caseId: string; docId: string; similarity: number }
export interface Pairing {
  pairs: Pair[];
  /** Cases with no document above the threshold: probably undocumented or outdated. */
  orphanCases: string[];
  /** Documents no case points to: probably not covered by tests. */
  uncoveredDocs: string[];
}

export function pairUp(docs: DocRecord[], cases: TestCaseRecord[], opts: { perCase?: number; min?: number } = {}): Pairing {
  const perCase = opts.perCase ?? 2;
  const min = opts.min ?? 0.1;
  const docCounts = docs.map((d) => tf(terms(docText(d))));
  const caseCounts = cases.map((c) => tf(terms(caseText(c))));
  const df = new Map<string, number>();
  for (const m of [...docCounts, ...caseCounts]) for (const t of m.keys()) df.set(t, (df.get(t) ?? 0) + 1);
  const n = docCounts.length + caseCounts.length;
  const idf = new Map([...df].map(([t, k]) => [t, Math.log((n + 1) / (k + 1)) + 1] as const));

  const index = new Map<string, { doc: number; w: number }[]>();
  docCounts.forEach((m, doc) => {
    for (const [t, w] of weigh(m, idf)) {
      let list = index.get(t);
      if (!list) index.set(t, (list = []));
      list.push({ doc, w });
    }
  });

  const pairs: Pair[] = [];
  const orphanCases: string[] = [];
  const covered = new Set<number>();
  caseCounts.forEach((m, ci) => {
    const score = new Map<number, number>();
    for (const [t, w] of weigh(m, idf)) for (const p of index.get(t) ?? []) score.set(p.doc, (score.get(p.doc) ?? 0) + w * p.w);
    const top = [...score].filter(([, s]) => s >= min).sort((a, b) => b[1] - a[1]).slice(0, perCase);
    if (!top.length) orphanCases.push(cases[ci].id);
    for (const [doc, s] of top) {
      covered.add(doc);
      pairs.push({ caseId: cases[ci].id, docId: docs[doc].id, similarity: Math.round(s * 1000) / 1000 });
    }
  });
  pairs.sort((a, b) => b.similarity - a.similarity);
  return { pairs, orphanCases, uncoveredDocs: docs.filter((_, i) => !covered.has(i)).map((d) => d.id) };
}
