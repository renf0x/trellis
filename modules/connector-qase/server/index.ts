import { HttpError, type DocRecord, type ServerModuleContext, type TestCaseRecord } from "@trellis/core";
import {
  DEFAULT_HOST,
  QaseClient,
  QaseError,
  caseUrl,
  flattenSteps,
  normalizeHost,
  suitePaths,
  testConnection,
  type CheckResult,
  type QaseCase,
  type QaseSuite,
} from "./qase.ts";

export const SOURCE = "qase";

interface Settings {
  host: string;
  project: string;
  /** Suites with a description or preconditions also become documentation pages. */
  suitesAsDocs: boolean;
  lastCheck?: CheckResult & { at: string };
}
interface Job { phase: "suites" | "cases" | "saving" | "done" | "error"; message: string; docs: number; cases: number; running: boolean }

const CODE_RE = /^[A-Z][A-Z0-9]{1,9}$/;
const PRIORITY: Record<string, number> = { high: 1, medium: 2, low: 3 };
const STATUS: Record<string, string> = { "0": "Actual", "1": "Draft", "2": "Deprecated" };

function priorityOf(p: QaseCase["priority"]): number | undefined {
  if (typeof p === "number") return p >= 1 && p <= 3 ? p : undefined;
  return p ? PRIORITY[String(p).toLowerCase()] : undefined;
}

export function toCase(host: string, code: string, c: QaseCase, paths: Map<number, string>): TestCaseRecord {
  const pre = c.preconditions?.trim();
  const steps = flattenSteps(c.steps).map((s) => ({ kind: "step" as const, ...s }));
  const p = priorityOf(c.priority);
  return {
    id: `${SOURCE}:${code}-${c.id}`, source: SOURCE, externalId: `${code}-${c.id}`, title: c.title,
    state: c.status === undefined || c.status === null ? "" : (STATUS[String(c.status)] ?? String(c.status)),
    ...(p ? { priority: p } : {}),
    suites: [c.suite_id && paths.get(c.suite_id) ? `${code} / ${paths.get(c.suite_id)}` : code],
    steps: pre ? [{ kind: "step", action: `Предусловие: ${pre}`, expected: "" }, ...steps] : steps,
    url: caseUrl(host, code, c.id),
  };
}

export function suiteDoc(host: string, code: string, s: QaseSuite, paths: Map<number, string>): DocRecord | null {
  const parts = [s.description?.trim(), s.preconditions?.trim() ? `**Предусловия:** ${s.preconditions.trim()}` : ""].filter(Boolean);
  if (!parts.length) return null;
  const path = paths.get(s.id) ?? s.title;
  const app = host === DEFAULT_HOST ? "https://app.qase.io" : host.replace("//api.", "//app.");
  return {
    id: `${SOURCE}:${code}:suite-${s.id}`, source: SOURCE, container: `Qase · ${code}`,
    path: `/${path.split(" / ").join("/")}`, title: s.title, content: parts.join("\n\n"),
    url: `${app}/project/${code}?suite=${s.id}`,
  };
}

function str(v: unknown, field: string, max = 300): string {
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is longer than ${max}`);
  return s;
}

export function register(ctx: ServerModuleContext) {
  const settings = async (): Promise<Settings> =>
    ({ host: DEFAULT_HOST, project: "", suitesAsDocs: true, ...(await ctx.files.read<Settings>("settings")) });
  const token = async () => process.env.QASE_TOKEN || (await ctx.secrets.get()).token || undefined;
  const client = async (s: Settings) => new QaseClient(s.host, await token());
  const wrap = async <T>(f: () => Promise<T>) => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof QaseError) throw new HttpError(e.status === 401 || e.status === 404 ? 400 : 502, e.message);
      throw e;
    }
  };

  ctx.route("GET", "/settings", async () => {
    const s = await settings();
    const t = await token();
    return { ...s, hasToken: !!t, tokenHint: t ? `…${t.slice(-4)}` : undefined, tokenFromEnv: !!process.env.QASE_TOKEN };
  });

  ctx.route("POST", "/settings", async ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const next = await settings();
    if (b.host !== undefined) {
      try {
        next.host = normalizeHost(str(b.host, "host"));
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (b.project !== undefined) {
      const p = str(b.project, "project", 10).toUpperCase();
      if (p && !CODE_RE.test(p)) throw new HttpError(400, "Код проекта: 2–10 латинских букв и цифр, как в номерах кейсов (DEMO-1 → DEMO)");
      next.project = p;
    }
    if (b.suitesAsDocs !== undefined) next.suitesAsDocs = b.suitesAsDocs === true;
    if (b.token !== undefined) await ctx.secrets.set({ token: str(b.token, "token", 500) || null });
    delete next.lastCheck;
    await ctx.files.write("settings", next);
    return { ok: true };
  });

  ctx.route("POST", "/test", async () => {
    const s = await settings();
    if (!s.project) throw new HttpError(400, "Укажите код проекта Qase");
    const result = await testConnection(await client(s), s.project);
    await ctx.files.write("settings", { ...s, lastCheck: { ...result, at: new Date().toISOString() } });
    ctx.log(`qase check ${result.ok ? "ok" : "failed"}: ${result.steps.map((x) => `${x.id}=${x.ok}`).join(" ")}`);
    return result;
  });

  let job: Job | null = null;
  ctx.route("GET", "/sync", async () => ({ job, source: (await ctx.data.sources()).find((x) => x.source === SOURCE) ?? null }));
  ctx.route("POST", "/sync", async () => {
    if (job?.running) throw new HttpError(409, "Загрузка уже идёт");
    const s = await settings();
    if (!s.project) throw new HttpError(400, "Укажите код проекта Qase");
    const c = await client(s);
    if (!c.hasToken) throw new HttpError(400, "Укажите API-токен Qase");
    const current: Job = { phase: "suites", message: "Сьюты", docs: 0, cases: 0, running: true };
    job = current;
    void (async () => {
      try {
        const suites = await c.all<QaseSuite>(`suite/${s.project}`, (n) => (current.message = `Сьюты: ${n}`));
        const paths = suitePaths(suites);
        current.phase = "cases";
        const raw = await c.all<QaseCase>(`case/${s.project}`, (n) => ((current.cases = n), (current.message = `Тест-кейсы: ${n}`)));
        const cases = raw.map((x) => toCase(s.host, s.project, x, paths));
        const docs = s.suitesAsDocs ? suites.map((x) => suiteDoc(s.host, s.project, x, paths)).filter((d): d is DocRecord => !!d) : [];
        current.phase = "saving";
        await ctx.data.replace({ source: SOURCE, title: `Qase · ${s.project}`, syncedAt: new Date().toISOString(), docs, cases });
        current.docs = docs.length;
        current.cases = cases.length;
        current.phase = "done";
        current.message = `Загружено: ${cases.length} тест-кейсов${s.suitesAsDocs ? `, ${docs.length} описаний сьютов в документацию` : ""}`;
      } catch (e) {
        current.phase = "error";
        current.message = `${(e as Error).message}. Прежние данные сохранены.`;
      } finally {
        current.running = false;
        ctx.log(`qase sync ${current.phase}: docs=${current.docs} cases=${current.cases}`);
      }
    })();
    return current;
  });

  ctx.route("GET", "/projects", async () => {
    const s = await settings();
    return wrap(async () => (await (await client(s)).all<{ title: string; code: string }>("project", undefined, 500)).map((p) => ({ title: p.title, code: p.code })));
  });
}
