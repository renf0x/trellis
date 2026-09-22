import { HttpError, type ServerModuleContext } from "@trellis/core";
import {
  AzureClient,
  AzureError,
  listCases,
  listPlans,
  listSuites,
  listWikis,
  normalizeBaseUrl,
  testConnection,
  wikiPage,
  wikiTree,
  type AzureConfig,
  type CheckResult,
} from "./azure.ts";
import { SOURCE, syncAzure, type SyncProgress } from "./sync.ts";

interface Settings {
  baseUrl: string;
  project: string;
  apiVersion?: string;
  lastCheck?: CheckResult & { at: string };
}

function str(v: unknown, field: string, max = 300): string {
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is longer than ${max}`);
  return s;
}
const int = (v: string | undefined, field: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, `bad ${field}`);
  return n;
};
const hint = (pat?: string) => (pat ? `…${pat.slice(-4)}` : undefined);

export function register(ctx: ServerModuleContext) {
  const settings = async () => (await ctx.files.read<Settings>("settings")) ?? { baseUrl: "", project: "" };
  const pat = async () => process.env.AZURE_DEVOPS_PAT || (await ctx.secrets.get()).pat || undefined;

  /** Azure failures reach the UI as 502 with the readable message, not as a bare 500. */
  const guard = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (err) {
      if (err instanceof AzureError) {
        const anonymous = (err.kind === "auth" || err.kind === "signin") && !(await pat());
        throw new HttpError(err.status === 404 ? 404 : 502,
          anonymous ? "Без PAT (анонимно) это недоступно: задайте PAT в подключении." : err.message);
      }
      throw err;
    }
  };
  const client = async () => {
    const s = await settings();
    if (!s.baseUrl || !s.project) throw new HttpError(400, "Azure DevOps не настроен: укажите организацию и проект");
    if (!s.apiVersion) throw new HttpError(400, "Сначала нажмите «Проверить подключение»");
    return new AzureClient({ baseUrl: s.baseUrl, project: s.project, apiVersion: s.apiVersion } as AzureConfig, await pat());
  };

  ctx.route("GET", "/settings", async () => {
    const s = await settings();
    const p = await pat();
    return { ...s, hasPat: !!p, patHint: hint(p), patFromEnv: !!process.env.AZURE_DEVOPS_PAT };
  });

  ctx.route("POST", "/settings", async ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const prev = await settings();
    const next: Settings = { ...prev };
    if (b.baseUrl !== undefined) next.baseUrl = guardUrl(str(b.baseUrl, "baseUrl"));
    if (b.project !== undefined) next.project = str(b.project, "project", 128);
    if (next.baseUrl !== prev.baseUrl || next.project !== prev.project) {
      delete next.apiVersion;
      delete next.lastCheck;
    }
    if (b.pat !== undefined) {
      const p = str(b.pat, "pat", 200);
      await ctx.secrets.set({ pat: p || null });
      delete next.lastCheck;
    }
    await ctx.files.write("settings", next);
    return { ok: true, baseUrl: next.baseUrl };
  });

  ctx.route("POST", "/test", async () => {
    const s = await settings();
    if (!s.baseUrl || !s.project) throw new HttpError(400, "Укажите организацию (или адрес коллекции) и проект");
    const result = await testConnection({ baseUrl: s.baseUrl, project: s.project }, await pat());
    const next: Settings = { ...s, lastCheck: { ...result, at: new Date().toISOString() } };
    if (result.apiVersion) next.apiVersion = result.apiVersion;
    await ctx.files.write("settings", next);
    ctx.log(`azure check ${result.ok ? "ok" : "failed"}: ${result.steps.map((x) => `${x.id}=${x.ok}`).join(" ")}`);
    return next.lastCheck;
  });

  // One sync at a time; the UI polls GET /sync for progress.
  let job: (SyncProgress & { running: boolean; startedAt: string }) | null = null;
  ctx.route("GET", "/sync", async () => ({
    job,
    source: (await ctx.data.sources()).find((s) => s.source === SOURCE) ?? null,
  }));
  ctx.route("POST", "/sync", async () => {
    if (job?.running) throw new HttpError(409, "Синхронизация уже идёт");
    const c = await client();
    const current = { phase: "wiki", message: "Начало", docs: 0, cases: 0, warnings: [], running: true, startedAt: new Date().toISOString() } as NonNullable<typeof job>;
    job = current;
    void (async () => {
      try {
        const snap = await syncAzure(c, current);
        if (!(await pat())) {
          current.warnings = current.warnings.map((w) => w.replace(/Доступ отклонён \(401\).*$/, "без PAT (анонимно) нет доступа."));
        }
        // Everything failing (expired PAT, VPN down) must not wipe the data loaded last time.
        if (!snap.docs.length && !snap.cases.length && current.warnings.length) {
          throw new Error("Ничего не загружено, прежние данные сохранены. " + current.warnings[0]);
        }
        current.phase = "saving";
        current.message = "Сохранение";
        await ctx.data.replace(snap);
        current.phase = "done";
        current.message = `Загружено: ${snap.docs.length} стр. документации, ${snap.cases.length} тест-кейсов`;
      } catch (err) {
        current.phase = "error";
        current.message = (err as Error).message;
      } finally {
        current.running = false;
        ctx.log(`azure sync ${current.phase}: docs=${current.docs} cases=${current.cases} warnings=${current.warnings.length}`);
      }
    })();
    return current;
  });

  ctx.route("GET", "/wikis",async () => guard(async () => listWikis(await client())));
  ctx.route("GET", "/wikis/:id/tree", async ({ params }) => guard(async () => wikiTree(await client(), params.id)));
  ctx.route("GET", "/wikis/:id/page", async ({ params, query }) =>
    guard(async () => wikiPage(await client(), params.id, str(query.path ?? "/", "path", 1000))));

  ctx.route("GET", "/plans", async () => guard(async () => listPlans(await client())));
  ctx.route("GET", "/plans/:plan/suites", async ({ params }) =>
    guard(async () => listSuites(await client(), int(params.plan, "plan"))));
  ctx.route("GET", "/plans/:plan/suites/:suite/cases", async ({ params }) =>
    guard(async () => listCases(await client(), int(params.plan, "plan"), int(params.suite, "suite"))));
}

function guardUrl(raw: string): string {
  if (!raw) return "";
  try {
    return normalizeBaseUrl(raw);
  } catch (err) {
    throw new HttpError(400, err instanceof Error ? err.message : "bad url");
  }
}
