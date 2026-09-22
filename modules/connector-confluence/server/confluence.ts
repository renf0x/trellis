// Confluence REST client, read only.
// Cloud (https://site.atlassian.net/wiki): email + API token (Basic), pages via REST v2 with cursor paging.
// Server/Data Center: personal access token (Bearer), pages via REST v1 with start/limit.

export type ConfluenceErrorKind = "network" | "auth" | "forbidden" | "notfound" | "http";
export class ConfluenceError extends Error {
  constructor(readonly kind: ConfluenceErrorKind, readonly status: number, message: string) {
    super(message);
    this.name = "ConfluenceError";
  }
}

export const isCloud = (baseUrl: string) => /\.(atlassian\.net|jira\.com)$/i.test(new URL(baseUrl).hostname);

/** Accepts "mysite", "mysite.atlassian.net", a page link, or a Server URL with a context path. */
export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error("Укажите адрес Confluence");
  if (/^[a-z0-9-]+$/i.test(s)) s = `https://${s}.atlassian.net`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (isCloud(s)) return `${u.protocol}//${u.host}/wiki`;
  // Drop UI paths people copy from the browser (display, spaces, pages, rest).
  const path = u.pathname.replace(/\/(display|spaces|pages|rest|plugins|dashboard\.action|x)(\/.*)?$/i, "").replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${path}`;
}

function classify(status: number, body: string): ConfluenceError {
  let msg = "";
  try {
    const j = JSON.parse(body);
    msg = j.message ?? j.errors?.map((e: { title?: string }) => e.title).join("; ") ?? "";
  } catch {
    /* html or empty */
  }
  if (status === 401) return new ConfluenceError("auth", 401, "Доступ отклонён (401): проверьте email и токен.");
  if (status === 403) return new ConfluenceError("forbidden", 403, `Нет прав (403)${msg ? `: ${msg}` : ""}.`);
  if (status === 404) return new ConfluenceError("notfound", 404, msg || "Не найдено (404)");
  if (status === 429) return new ConfluenceError("http", 429, "429: превышен лимит запросов Confluence, попробуйте через минуту");
  return new ConfluenceError("http", status, `Confluence ответил ${status}${msg ? `: ${msg}` : ""}`);
}

export class ConfluenceClient {
  constructor(readonly baseUrl: string, private readonly email?: string, private readonly token?: string, private readonly fetchImpl: typeof fetch = fetch) {}

  get hasToken() {
    return !!this.token;
  }
  get cloud() {
    return isCloud(this.baseUrl);
  }

  private auth(): Record<string, string> {
    if (!this.token) return {};
    if (this.cloud) {
      if (!this.email) throw new ConfluenceError("auth", 401, "Для Confluence Cloud укажите email учётной записи вместе с API-токеном.");
      return { Authorization: `Basic ${Buffer.from(`${this.email}:${this.token}`).toString("base64")}` };
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  /** `path` is relative to the base, e.g. "rest/api/user/current" or "api/v2/pages". Absolute next-links are accepted too. */
  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = /^https?:/.test(path) ? new URL(path) : new URL(`${this.baseUrl}/${path.replace(/^\//, "")}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { Accept: "application/json", ...this.auth() }, redirect: "manual", signal: AbortSignal.timeout(30_000) });
      } catch (err) {
        if (err instanceof ConfluenceError) throw err;
        const e = err as Error & { cause?: { code?: string } };
        const code = e.cause?.code ?? e.name;
        const host = url.host;
        if (code === "ENOTFOUND" || code === "EAI_AGAIN") throw new ConfluenceError("network", 0, `Адрес ${host} не найден (DNS): проверьте адрес или VPN.`);
        if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(code))) {
          throw new ConfluenceError("network", 0, `Сертификат ${host} не принят. Для корпоративного сертификата запустите с NODE_EXTRA_CA_CERTS=<путь к .pem>.`);
        }
        if (code === "TimeoutError" || code === "AbortError") throw new ConfluenceError("network", 0, `${host} не ответил за 30 с: VPN или прокси?`);
        throw new ConfluenceError("network", 0, `Нет соединения с ${host}: ${e.message}`);
      }
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, Math.min(Number(res.headers.get("retry-after")) || 5, 30) * 1000));
        continue;
      }
      const text = await res.text();
      if (res.status >= 300 && res.status < 400) throw new ConfluenceError("auth", res.status, "Confluence перенаправляет на страницу входа: проверьте адрес и токен.");
      if (!res.ok) throw classify(res.status, text);
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new ConfluenceError("http", res.status, "Confluence вернул не JSON: проверьте адрес (для Server — с контекстным путём, например /confluence).");
      }
    }
  }
}

export interface Space { id?: string; key: string; name: string }
export interface Page { id: string; title: string; parentId?: string; body: string; webui?: string; version?: number }

/** Spaces visible to the token. */
export async function listSpaces(c: ConfluenceClient, max = 500): Promise<Space[]> {
  const out: Space[] = [];
  if (c.cloud) {
    let next: string | undefined = "api/v2/spaces";
    let q: Record<string, string | number | undefined> = { limit: 250 };
    while (next && out.length < max) {
      const r: { results: { id: string; key: string; name: string }[]; _links?: { next?: string } } = await c.get(next, q);
      out.push(...r.results.map((s) => ({ id: s.id, key: s.key, name: s.name })));
      next = r._links?.next ? nextLink(c, r._links.next) : undefined;
      q = {};
    }
  } else {
    for (;;) {
      const r = await c.get<{ results: { key: string; name: string }[]; size: number; limit: number }>("rest/api/space", { limit: 100, start: out.length });
      out.push(...r.results.map((s) => ({ key: s.key, name: s.name })));
      if (r.results.length < r.limit || !r.results.length || out.length >= max) break;
    }
  }
  return out;
}

/** v2 next-links are "/wiki/api/v2/…?cursor=…": resolve against the site origin. */
function nextLink(c: ConfluenceClient, link: string) {
  return new URL(link, new URL(c.baseUrl).origin).toString();
}

export async function getSpace(c: ConfluenceClient, key: string): Promise<Space> {
  if (c.cloud) {
    const r = await c.get<{ results: { id: string; key: string; name: string }[] }>("api/v2/spaces", { keys: key });
    const s = r.results[0];
    if (!s) throw new ConfluenceError("notfound", 404, `Пространство ${key} не найдено или нет доступа`);
    return { id: s.id, key: s.key, name: s.name };
  }
  const s = await c.get<{ key: string; name: string }>(`rest/api/space/${encodeURIComponent(key)}`);
  return { key: s.key, name: s.name };
}

/** Every current page of a space with its storage-format body. */
export async function spacePages(c: ConfluenceClient, space: Space, onPage?: (n: number) => void, max = 10_000): Promise<Page[]> {
  const out: Page[] = [];
  if (c.cloud) {
    let next: string | undefined = `api/v2/spaces/${space.id}/pages`;
    let q: Record<string, string | number | undefined> = { limit: 100, "body-format": "storage", status: "current" };
    while (next && out.length < max) {
      const r: { results: { id: string; title: string; parentId?: string | null; body?: { storage?: { value?: string } }; _links?: { webui?: string }; version?: { number?: number } }[]; _links?: { next?: string } } = await c.get(next, q);
      for (const p of r.results) {
        out.push({ id: p.id, title: p.title, parentId: p.parentId ?? undefined, body: p.body?.storage?.value ?? "", webui: p._links?.webui, version: p.version?.number });
      }
      onPage?.(out.length);
      next = r._links?.next ? nextLink(c, r._links.next) : undefined;
      q = {};
    }
  } else {
    for (;;) {
      const r = await c.get<{ results: { id: string; title: string; ancestors?: { id: string }[]; body?: { storage?: { value?: string } }; _links?: { webui?: string }; version?: { number?: number } }[]; limit: number }>(
        "rest/api/content", { spaceKey: space.key, type: "page", status: "current", expand: "body.storage,ancestors,version", limit: 50, start: out.length });
      for (const p of r.results) {
        out.push({ id: p.id, title: p.title, parentId: p.ancestors?.at(-1)?.id, body: p.body?.storage?.value ?? "", webui: p._links?.webui, version: p.version?.number });
      }
      onPage?.(out.length);
      if (!r.results.length || r.results.length < r.limit || out.length >= max) break;
    }
  }
  return out;
}

/** "/Parent/Child" path of every page inside its space (parents outside the list are ignored). */
export function pagePaths(pages: Page[]): Map<string, string> {
  const byId = new Map(pages.map((p) => [p.id, p]));
  const paths = new Map<string, string>();
  const clean = (t: string) => t.replace(/\//g, "∕");
  const path = (id: string, seen = new Set<string>()): string => {
    if (paths.has(id)) return paths.get(id)!;
    const p = byId.get(id);
    if (!p || seen.has(id)) return "";
    seen.add(id);
    const parent = p.parentId ? path(p.parentId, seen) : "";
    const full = `${parent}/${clean(p.title)}`;
    paths.set(id, full);
    return full;
  };
  for (const p of pages) path(p.id);
  return paths;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—", ndash: "–", laquo: "«", raquo: "»", hellip: "…" };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m));

/** Confluence storage format (XHTML with ac:/ri: macros) → Markdown, enough for reading and comparison. */
export function storageToMarkdown(html: string): string {
  if (!html) return "";
  const keep: string[] = [];
  const hold = (s: string) => (keep.push(s), `\u0000${keep.length - 1}\u0000`);
  let s = html.replace(/\r\n/g, "\n");
  // Code macro → fenced block.
  s = s.replace(/<ac:structured-macro[^>]*ac:name="(?:code|noformat)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_m, inner: string) => {
    const lang = inner.match(/<ac:parameter ac:name="language">([^<]*)<\/ac:parameter>/i)?.[1] ?? "";
    const body = inner.match(/<!\[CDATA\[([\s\S]*?)\]\]>/)?.[1] ?? "";
    return hold(`\n\`\`\`${lang}\n${body.trim()}\n\`\`\`\n`);
  });
  // Info/note/warning panels → quote with their body; other macros keep only their rich-text body.
  s = s.replace(/<ac:structured-macro[^>]*ac:name="(info|note|warning|tip)"[^>]*>[\s\S]*?<ac:rich-text-body>([\s\S]*?)<\/ac:rich-text-body>[\s\S]*?<\/ac:structured-macro>/gi,
    (_m, _k, body: string) => `<blockquote>${body}</blockquote>`);
  s = s.replace(/<ac:parameter[^>]*>[\s\S]*?<\/ac:parameter>/gi, "");
  // Links to other pages and attachments: keep the visible text or the target title.
  s = s.replace(/<ac:link[^>]*>([\s\S]*?)<\/ac:link>/gi, (_m, inner: string) => {
    const text = inner.match(/<ac:(?:plain-text-)?link-body>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/ac:(?:plain-text-)?link-body>/i)?.[1];
    const title = inner.match(/ri:content-title="([^"]*)"/i)?.[1] ?? inner.match(/ri:filename="([^"]*)"/i)?.[1] ?? "";
    return `«${(text ?? title).replace(/<[^>]+>/g, "")}»`;
  });
  s = s.replace(/<ac:image[\s\S]*?<\/ac:image>/gi, (m) => `[изображение${m.match(/ri:filename="([^"]*)"/i)?.[1] ? `: ${m.match(/ri:filename="([^"]*)"/i)![1]}` : ""}]`);
  s = s.replace(/<ac:task-status>complete<\/ac:task-status>/gi, "[x] ").replace(/<ac:task-status>[^<]*<\/ac:task-status>/gi, "[ ] ");
  s = s.replace(/<ac:task>/gi, "<li>").replace(/<\/ac:task>/gi, "</li>").replace(/<\/?ac:task-list>/gi, "");
  s = s.replace(/<\/?(ac|ri):[^>]*>/gi, "");
  s = s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  s = s.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, (_m, b: string) => hold(`\n\`\`\`\n${decode(b.replace(/<[^>]+>/g, "")).trim()}\n\`\`\`\n`));

  // Tables: one Markdown row per <tr>, header separator after the first row.
  s = s.replace(/<table[^>]*>([\s\S]*?)<\/table>/gi, (_m, t: string) => {
    const rows = [...t.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) =>
      [...r[1].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((c) => inline(c[1]).replace(/\n+/g, " ").replace(/\|/g, "\\|").trim()));
    if (!rows.length) return "";
    const w = Math.max(...rows.map((r) => r.length));
    const line = (r: string[]) => `| ${[...r, ...Array(w - r.length).fill("")].join(" | ")} |`;
    return hold(`\n${[line(rows[0]), `|${" --- |".repeat(w)}`, ...rows.slice(1).map(line)].join("\n")}\n`);
  });

  // Lists, nested by depth.
  let depth = 0;
  const stack: string[] = [];
  s = s.replace(/<(\/?)(ul|ol|li)[^>]*>/gi, (_m, close: string, tag: string) => {
    tag = tag.toLowerCase();
    if (tag === "li") return close ? "" : `\n${"  ".repeat(Math.max(depth - 1, 0))}${stack.at(-1) === "ol" ? "1." : "-"} `;
    if (close) {
      stack.pop();
      depth--;
      return depth ? "" : "\n\n";
    }
    stack.push(tag);
    depth++;
    return depth === 1 ? "\n" : "";
  });
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${inline(t).trim()}\n\n`);
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, b: string) => `\n\n${inline(b).trim().split("\n").map((l) => `> ${l}`).join("\n")}\n\n`);
  s = s.replace(/<\/p>|<p[^>]*>/gi, "\n\n").replace(/<br\s*\/?>/gi, "\n").replace(/<hr\s*\/?>/gi, "\n\n---\n\n");
  s = inline(s);
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => keep[Number(i)]).replace(/\n{3,}/g, "\n\n").trim();
}

function inline(s: string): string {
  return decode(
    s
      .replace(/<(strong|b)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_m, _t, x: string) => (x.trim() ? `**${x.trim()}**` : x))
      .replace(/<(em|i)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, (_m, _t, x: string) => (x.trim() ? `*${x.trim()}*` : x))
      .replace(/<(s|del|strike)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi, "~~$2~~")
      .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
      .replace(/<a [^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, t: string) => `[${t.replace(/<[^>]+>/g, "")}](${href})`)
      .replace(/<[^>]+>/g, ""),
  );
}

export interface CheckStep { id: string; title: string; ok: boolean; message: string }
export interface CheckResult { ok: boolean; cloud: boolean; user?: string; steps: CheckStep[] }

export async function testConnection(c: ConfluenceClient, spaces: string[]): Promise<CheckResult> {
  const steps: CheckStep[] = [];
  const run = async (id: string, title: string, fn: () => Promise<string>) => {
    try {
      steps.push({ id, title, ok: true, message: await fn() });
      return true;
    } catch (e) {
      steps.push({ id, title, ok: false, message: (e as Error).message });
      return false;
    }
  };
  let user: string | undefined;
  const okAuth = await run("auth", "Вход", async () => {
    const me = await c.get<{ displayName?: string; email?: string; type?: string }>("rest/api/user/current");
    if (me.type === "anonymous" || !me.displayName) {
      if (c.hasToken) throw new ConfluenceError("auth", 401, "Токен не принят: Confluence видит вас как анонима. Проверьте email и токен.");
      return "Без токена (анонимно): видно только то, что открыто всем";
    }
    user = me.displayName;
    return `Вход выполнен: ${user}${me.email ? ` (${me.email})` : ""}`;
  });
  if (!okAuth) return { ok: false, cloud: c.cloud, steps };
  let okSpaces = true;
  for (const key of spaces) {
    okSpaces = (await run(`space:${key}`, `Пространство ${key}`, async () => `${(await getSpace(c, key)).name}`)) && okSpaces;
  }
  return { ok: okSpaces && spaces.length > 0, cloud: c.cloud, user, steps };
}
