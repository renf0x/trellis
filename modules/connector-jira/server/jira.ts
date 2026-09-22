// Jira REST client for Cloud (email + API token, Basic) and Server/Data Center (personal access token, Bearer).
// Read-only. REST v2 is used everywhere: it returns descriptions as wiki markup on both Cloud and Server.
import type { TestStepRecord } from "@trellis/core";

export interface JiraConfig {
  baseUrl: string;
  /** Cloud needs the account email next to the API token; Server/DC uses the token alone. */
  email?: string;
}

export type JiraErrorKind = "network" | "auth" | "forbidden" | "notfound" | "jql" | "captcha" | "http";
export class JiraError extends Error {
  constructor(readonly kind: JiraErrorKind, readonly status: number, message: string) {
    super(message);
    this.name = "JiraError";
  }
}

export const isCloud = (baseUrl: string) => /\.(atlassian\.net|jira\.com)$/i.test(new URL(baseUrl).hostname);

/** Accepts "mysite", "mysite.atlassian.net", a browse link or a Server URL with a context path. */
export function normalizeBaseUrl(raw: string): string {
  let s = raw.trim();
  if (!s) throw new Error("Укажите адрес Jira");
  if (/^[a-z0-9-]+$/i.test(s)) s = `https://${s}.atlassian.net`;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  // Drop UI paths people copy from the browser.
  const path = u.pathname.replace(/\/(browse|projects|secure|issues|plugins)(\/.*)?$/i, "").replace(/\/+$/, "");
  return `${u.protocol}//${u.host}${isCloud(s) ? "" : path}`;
}

function classify(status: number, body: string, headers: Headers): JiraError {
  let msg = "";
  try {
    const j = JSON.parse(body);
    msg = [...(j.errorMessages ?? []), ...Object.values(j.errors ?? {})].join("; ") || j.message || "";
  } catch {
    /* html or empty */
  }
  if (headers.get("x-seraph-loginreason")?.includes("CAPTCHA")) {
    return new JiraError("captcha", status, "Jira требует ввести капчу: войдите один раз в браузере, затем повторите.");
  }
  if (status === 401) return new JiraError("auth", 401, "Доступ отклонён (401): проверьте email и токен.");
  if (status === 403) return new JiraError("forbidden", 403, `Нет прав (403)${msg ? `: ${msg}` : ""}.`);
  if (status === 404) return new JiraError("notfound", 404, msg || "Не найдено (404)");
  if (status === 400) return new JiraError("jql", 400, msg || "Неверный запрос (400)");
  return new JiraError("http", status, `Jira ответила ${status}${msg ? `: ${msg}` : ""}`);
}

export class JiraClient {
  constructor(readonly cfg: JiraConfig, private readonly token?: string, private readonly fetchImpl: typeof fetch = fetch) {}

  get hasToken() {
    return !!this.token;
  }

  private auth(): Record<string, string> {
    if (!this.token) return {};
    if (isCloud(this.cfg.baseUrl)) {
      if (!this.cfg.email) throw new JiraError("auth", 401, "Для Jira Cloud укажите email учётной записи вместе с API-токеном.");
      return { Authorization: `Basic ${Buffer.from(`${this.cfg.email}:${this.token}`).toString("base64")}` };
    }
    return { Authorization: `Bearer ${this.token}` };
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const url = new URL(`${this.cfg.baseUrl}/rest/api/2/${path}`);
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, String(v));
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: { Accept: "application/json", ...this.auth() }, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      if (err instanceof JiraError) throw err;
      const e = err as Error & { cause?: { code?: string } };
      const code = e.cause?.code ?? e.name;
      const host = url.host;
      if (code === "ENOTFOUND" || code === "EAI_AGAIN") throw new JiraError("network", 0, `Адрес ${host} не найден (DNS): проверьте адрес или VPN.`);
      if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(String(code))) {
        throw new JiraError("network", 0, `Сертификат ${host} не принят. Для корпоративного сертификата запустите с NODE_EXTRA_CA_CERTS=<путь к .pem>.`);
      }
      if (code === "TimeoutError" || code === "AbortError") throw new JiraError("network", 0, `${host} не ответил за 20 с: VPN или прокси?`);
      throw new JiraError("network", 0, `Нет соединения с ${host}: ${e.message}`);
    }
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) throw new JiraError("auth", res.status, "Jira перенаправляет на страницу входа: проверьте токен.");
    if (!res.ok) throw classify(res.status, text, res.headers);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new JiraError("http", res.status, "Jira вернула не JSON: проверьте адрес (для Server — с контекстным путём, например /jira).");
    }
  }
}

export interface JiraIssue {
  id: string;
  key: string;
  fields: {
    summary?: string;
    description?: string | null;
    status?: { name: string };
    issuetype?: { name: string };
    priority?: { name: string; id: string } | null;
    components?: { name: string }[];
    labels?: string[];
    project?: { key: string; name: string };
  };
}

const FIELDS = "summary,description,status,issuetype,priority,components,labels,project";

/**
 * All issues for a JQL query. Cloud: /search/jql with nextPageToken (the old /search is gone there);
 * Server/DC: /search with startAt.
 */
export async function searchAll(c: JiraClient, jql: string, max = 5000, onPage?: (n: number) => void): Promise<JiraIssue[]> {
  const out: JiraIssue[] = [];
  if (isCloud(c.cfg.baseUrl)) {
    let token: string | undefined;
    do {
      const r = await c.get<{ issues: JiraIssue[]; nextPageToken?: string }>("search/jql",
        { jql, fields: FIELDS, maxResults: 100, nextPageToken: token });
      out.push(...r.issues);
      onPage?.(out.length);
      token = r.issues.length ? r.nextPageToken : undefined;
    } while (token && out.length < max);
  } else {
    for (;;) {
      const r = await c.get<{ issues: JiraIssue[]; total: number }>("search", { jql, fields: FIELDS, maxResults: 100, startAt: out.length });
      out.push(...r.issues);
      onPage?.(out.length);
      if (!r.issues.length || out.length >= r.total || out.length >= max) break;
    }
  }
  return out.slice(0, max);
}

/** Jira wiki markup → Markdown, enough for descriptions: headings, emphasis, code, lists, tables, links. */
export function wikiToMarkdown(src: string | null | undefined): string {
  if (!src) return "";
  const blocks: string[] = [];
  let s = src.replace(/\r\n/g, "\n")
    .replace(/\{code(?::([a-z0-9]+))?[^}]*\}([\s\S]*?)\{code\}/gi, (_m, lang, body) => (blocks.push(`\`\`\`${lang ?? ""}\n${body.trim()}\n\`\`\``), `\u0000${blocks.length - 1}\u0000`))
    .replace(/\{noformat\}([\s\S]*?)\{noformat\}/gi, (_m, body) => (blocks.push(`\`\`\`\n${body.trim()}\n\`\`\``), `\u0000${blocks.length - 1}\u0000`));
  const lines = s.split("\n").map((line) => {
    // Lists first: in Jira "#" is a numbered list item, in Markdown it would be a heading.
    let l = line
      .replace(/^(#+)\s+/, (_m, h) => `${"   ".repeat(h.length - 1)}1. `)
      .replace(/^(\*+)\s+/, (_m, h) => `${"  ".repeat(h.length - 1)}- `)
      .replace(/^h([1-6])\.\s*/, (_m, n) => `${"#".repeat(Number(n))} `)
      .replace(/^bq\.\s*/, "> ");
    if (/^\s*\|\|/.test(l)) {
      const cells = l.trim().replace(/^\|\||\|\|$/g, "").split("||").map((c) => c.trim());
      return `| ${cells.join(" | ")} |\n|${cells.map(() => " --- ").join("|")}|`;
    }
    l = l
      .replace(/\{\{(.+?)\}\}/g, "`$1`")
      .replace(/(^|[\s(])\*(\S[^*]*?)\*(?=[\s).,:;!?]|$)/g, "$1**$2**")
      .replace(/(^|[\s(])_(\S[^_]*?)_(?=[\s).,:;!?]|$)/g, "$1*$2*")
      .replace(/(^|[\s(])-(\S[^-]*?)-(?=[\s).,:;!?]|$)/g, "$1~~$2~~")
      .replace(/\[([^|\]]+)\|([^\]]+)\]/g, "[$1]($2)")
      .replace(/\{color[^}]*\}/g, "");
    return l;
  });
  s = lines.join("\n");
  return s.replace(/\u0000(\d+)\u0000/g, (_m, i) => blocks[Number(i)]).trim();
}

/**
 * Steps from a plain Jira issue (no Xray/Zephyr): a table "| step | expected |" wins,
 * else a numbered list where "Ожидаемый результат:/Expected:" lines attach to the step above.
 */
export function stepsFromDescription(src: string | null | undefined): TestStepRecord[] {
  if (!src) return [];
  const rows = src.split(/\r?\n/).filter((l) => /^\s*\|[^|]/.test(l));
  if (rows.length) {
    const steps: TestStepRecord[] = [];
    for (const r of rows) {
      const cells = r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const [first, ...rest] = cells[0] && /^\d+\.?$/.test(cells[0]) ? cells.slice(1) : cells;
      if (first) steps.push({ kind: "step", action: first, expected: rest.filter(Boolean).join(" ").trim() });
    }
    if (steps.length) return steps;
  }
  const steps: TestStepRecord[] = [];
  for (const line of src.split(/\r?\n/)) {
    const num = line.match(/^\s*(?:#+|\d+[.)])\s+(.+)/);
    const exp = line.match(/^\s*(?:ожидаемый результат|ожидается|expected(?: result)?)\s*[:\-—]\s*(.+)/i);
    if (num) steps.push({ kind: "step", action: num[1].trim(), expected: "" });
    else if (exp && steps.length) steps[steps.length - 1].expected = exp[1].trim();
  }
  return steps;
}

export interface CheckStep { id: string; title: string; ok: boolean; message: string }
export interface CheckResult { ok: boolean; cloud: boolean; user?: string; steps: CheckStep[] }

export async function testConnection(c: JiraClient, project: string, jql: { docs: string; cases: string }): Promise<CheckResult> {
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
  const cloud = isCloud(c.cfg.baseUrl);
  let user: string | undefined;
  const okServer = await run("server", "Сервер", async () => {
    const i = await c.get<{ version?: string; deploymentType?: string; serverTitle?: string }>("serverInfo");
    return `${i.serverTitle ?? "Jira"} ${i.deploymentType ?? ""} ${i.version ?? ""}`.replace(/\s+/g, " ").trim();
  });
  if (!okServer) return { ok: false, cloud, steps };
  const okAuth = await run("auth", "Вход", async () => {
    if (!c.hasToken) return "Без токена (анонимно): видно только то, что Jira открывает всем";
    const me = await c.get<{ displayName?: string; emailAddress?: string; name?: string }>("myself");
    user = me.displayName ?? me.name;
    return `Вход выполнен: ${user}${me.emailAddress ? ` (${me.emailAddress})` : ""}`;
  });
  if (!okAuth) return { ok: false, cloud, steps };
  const okProject = await run("project", "Проект", async () => {
    const p = await c.get<{ key: string; name: string }>(`project/${encodeURIComponent(project)}`);
    return `${p.key} · ${p.name}`;
  });
  const probe = async (q: string) => {
    const r = await c.get<{ issues: JiraIssue[]; total?: number }>(cloud ? "search/jql" : "search", { jql: q, fields: "summary", maxResults: 1 });
    return r.total !== undefined ? `найдено задач: ${r.total}` : r.issues.length ? "запрос верный, задачи есть" : "запрос верный, но задач нет";
  };
  const okDocs = await run("docs", "JQL документации", () => probe(jql.docs));
  const okCases = jql.cases ? await run("cases", "JQL тест-кейсов", () => probe(jql.cases)) : true;
  if (!jql.cases) steps.push({ id: "cases", title: "JQL тест-кейсов", ok: true, message: "не задан: кейсы из Jira не загружаются" });
  return { ok: okProject && okDocs && okCases, cloud, user, steps };
}
