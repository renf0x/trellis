import { HttpError, type DocRecord, type ServerModuleContext } from "@trellis/core";
import {
  ConfluenceClient,
  ConfluenceError,
  getSpace,
  isCloud,
  listSpaces,
  normalizeBaseUrl,
  pagePaths,
  spacePages,
  storageToMarkdown,
  testConnection,
  type CheckResult,
  type Page,
  type Space,
} from "./confluence.ts";

export const SOURCE = "confluence";

interface Settings {
  baseUrl: string;
  email: string;
  /** Space keys whose pages become documentation. */
  spaces: string[];
  lastCheck?: CheckResult & { at: string };
}
interface Job { phase: "pages" | "saving" | "done" | "error"; message: string; docs: number; warnings: string[]; running: boolean; startedAt: string }

const SPACE_RE = /^~?[A-Za-z0-9_-]{1,255}$/;

function str(v: unknown, field: string, max = 300): string {
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is longer than ${max}`);
  return s;
}

export function toDoc(baseUrl: string, space: Space, p: Page, paths: Map<string, string>): DocRecord {
  return {
    id: `${SOURCE}:${space.key}:${p.id}`, source: SOURCE, container: `${space.name} (${space.key})`,
    path: paths.get(p.id) ?? `/${p.title}`, title: p.title, content: storageToMarkdown(p.body),
    url: p.webui ? `${baseUrl}${p.webui}` : `${baseUrl}/pages/viewpage.action?pageId=${p.id}`,
  };
}

export function register(ctx: ServerModuleContext) {
  const settings = async (): Promise<Settings> =>
    ({ baseUrl: "", email: "", spaces: [], ...(await ctx.files.read<Settings>("settings")) });
  const token = async () => process.env.CONFLUENCE_TOKEN || (await ctx.secrets.get()).token || undefined;
  const client = async (s: Settings) => {
    if (!s.baseUrl) throw new HttpError(400, "Confluence не настроен: укажите адрес");
    return new ConfluenceClient(s.baseUrl, s.email || undefined, await token());
  };
  const wrap = async <T>(f: () => Promise<T>) => {
    try {
      return await f();
    } catch (e) {
      if (e instanceof ConfluenceError) throw new HttpError(e.status === 401 || e.status === 404 ? 400 : 502, e.message);
      throw e;
    }
  };

  ctx.route("GET", "/settings", async () => {
    const s = await settings();
    const t = await token();
    return { ...s, cloud: s.baseUrl ? isCloud(s.baseUrl) : null, hasToken: !!t, tokenHint: t ? `…${t.slice(-4)}` : undefined, tokenFromEnv: !!process.env.CONFLUENCE_TOKEN };
  });

  ctx.route("POST", "/settings", async ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const next = await settings();
    if (b.baseUrl !== undefined) {
      const raw = str(b.baseUrl, "baseUrl");
      try {
        next.baseUrl = raw ? normalizeBaseUrl(raw) : "";
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    }
    if (b.email !== undefined) next.email = str(b.email, "email", 200);
    if (b.spaces !== undefined) {
      const list = (Array.isArray(b.spaces) ? b.spaces : str(b.spaces, "spaces", 2000).split(/[\s,;]+/))
        .map((x) => str(x, "space", 255)).filter(Boolean);
      const bad = list.find((k) => !SPACE_RE.test(k));
      if (bad) throw new HttpError(400, `Ключ пространства «${bad}»: латиница, цифры, _ и -; как в адресе /spaces/KEY/`);
      if (list.length > 20) throw new HttpError(400, "Не больше 20 пространств");
      next.spaces = [...new Set(list)];
    }
    if (b.token !== undefined) await ctx.secrets.set({ token: str(b.token, "token", 500) || null });
    delete next.lastCheck;
    await ctx.files.write("settings", next);
    return { ok: true, baseUrl: next.baseUrl };
  });

  ctx.route("POST", "/test", async () => {
    const s = await settings();
    if (!s.baseUrl) throw new HttpError(400, "Укажите адрес Confluence");
    if (!s.spaces.length) throw new HttpError(400, "Укажите хотя бы одно пространство");
    const result = await testConnection(await client(s), s.spaces);
    await ctx.files.write("settings", { ...s, lastCheck: { ...result, at: new Date().toISOString() } });
    ctx.log(`confluence check ${result.ok ? "ok" : "failed"}: ${result.steps.map((x) => `${x.id}=${x.ok}`).join(" ")}`);
    return result;
  });

  ctx.route("GET", "/spaces", async () => {
    const s = await settings();
    return wrap(async () => (await listSpaces(await client(s))).map((x) => ({ key: x.key, name: x.name })));
  });

  let job: Job | null = null;
  ctx.route("GET", "/sync", async () => ({ job, source: (await ctx.data.sources()).find((x) => x.source === SOURCE) ?? null }));
  ctx.route("POST", "/sync", async () => {
    if (job?.running) throw new HttpError(409, "Загрузка уже идёт");
    const s = await settings();
    if (!s.spaces.length) throw new HttpError(400, "Укажите хотя бы одно пространство");
    const c = await client(s);
    const current: Job = { phase: "pages", message: "Страницы", docs: 0, warnings: [], running: true, startedAt: new Date().toISOString() };
    job = current;
    void (async () => {
      try {
        const docs: DocRecord[] = [];
        for (const key of s.spaces) {
          try {
            const space = await getSpace(c, key);
            const before = docs.length;
            const pages = await spacePages(c, space, (n) => (current.message = `${key}: ${n} страниц`));
            const paths = pagePaths(pages);
            for (const p of pages) docs.push(toDoc(s.baseUrl, space, p, paths));
            current.docs = docs.length;
            if (docs.length === before) current.warnings.push(`${key}: страниц нет`);
          } catch (e) {
            current.warnings.push(`${key}: ${(e as Error).message}`);
          }
        }
        if (!docs.length) throw new Error(`Ничего не загружено, прежние данные сохранены. ${current.warnings[0] ?? ""}`.trim());
        current.phase = "saving";
        await ctx.data.replace({ source: SOURCE, title: `Confluence · ${s.spaces.join(", ")}`, syncedAt: new Date().toISOString(), docs, cases: [] });
        current.phase = "done";
        current.message = `Загружено: ${docs.length} страниц в документацию`;
      } catch (e) {
        current.phase = "error";
        current.message = (e as Error).message;
      } finally {
        current.running = false;
        ctx.log(`confluence sync ${current.phase}: docs=${current.docs} warnings=${current.warnings.length}`);
      }
    })();
    return current;
  });
}
