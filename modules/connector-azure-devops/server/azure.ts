// Read-only Azure DevOps REST client (Services and on-prem Server). No writes live here on purpose:
// writes go through confirmed proposals (plan task 9).

export interface AzureConfig {
  /** https://dev.azure.com/<org> or an on-prem collection URL, e.g. https://tfs.corp/tfs/DefaultCollection. */
  baseUrl: string;
  project: string;
  /** Negotiated by testConnection; Server 2019 tops out at 5.x, 2020 at 6.0, 2022 at 7.0. */
  apiVersion: string;
}

export type AzureErrorKind = "network" | "tls" | "timeout" | "signin" | "auth" | "forbidden" | "not-found" | "version" | "http";

export class AzureError extends Error {
  constructor(readonly kind: AzureErrorKind, readonly status: number, message: string) {
    super(message);
    this.name = "AzureError";
  }
}

export const API_VERSIONS = ["7.1", "7.0", "6.0", "5.1", "5.0"];

/** Accepts "org", "https://dev.azure.com/org/project…", "https://org.visualstudio.com" or a collection URL. */
export function normalizeBaseUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, "");
  if (!s) throw new AzureError("http", 400, "Укажите организацию или адрес коллекции");
  if (!/^https?:\/\//i.test(s)) {
    if (/[/:]/.test(s)) throw new AzureError("http", 400, "Адрес должен начинаться с https://");
    return `https://dev.azure.com/${encodeURIComponent(s)}`;
  }
  const url = new URL(s);
  if (url.hostname === "dev.azure.com") {
    const org = url.pathname.split("/").filter(Boolean)[0];
    if (!org) throw new AzureError("http", 400, "В адресе dev.azure.com нет организации");
    return `https://dev.azure.com/${org}`;
  }
  if (url.hostname.endsWith(".visualstudio.com")) return `https://${url.hostname}`;
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const TLS_CODES = new Set([
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN", "DEPTH_ZERO_SELF_SIGNED_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

function networkError(err: unknown, host: string): AzureError {
  const e = err as { name?: string; cause?: { code?: string; message?: string } };
  if (e.name === "TimeoutError" || e.name === "AbortError") {
    return new AzureError("timeout", 0, `${host} не ответил за 20 с. Проверьте VPN или прокси.`);
  }
  const code = e.cause?.code ?? "";
  if (TLS_CODES.has(code)) {
    return new AzureError("tls", 0,
      `Сертификат ${host} не принят (${code}). Для корпоративного сертификата запустите сервер с ` +
      `переменной NODE_EXTRA_CA_CERTS=<путь к .pem корневого сертификата>.`);
  }
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") {
    return new AzureError("network", 0, `Адрес ${host} не найден (DNS). Проверьте адрес и VPN.`);
  }
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ETIMEDOUT") {
    return new AzureError("network", 0, `Нет соединения с ${host} (${code}). Проверьте VPN, прокси или порт.`);
  }
  return new AzureError("network", 0, `Нет соединения с ${host}: ${e.cause?.message ?? String(err)}`);
}

/** Maps an HTTP failure to a message a tester can act on. */
export function classifyHttp(status: number, contentType: string, body: string): AzureError {
  let message = "";
  try {
    message = String((JSON.parse(body) as { message?: string }).message ?? "");
  } catch { /* not JSON */ }
  if (status === 203 || (status >= 300 && status < 400) || (status < 300 && contentType.includes("text/html"))) {
    return new AzureError("signin", status, "Azure вернул страницу входа вместо данных: PAT неверный, истёк или выдан другой организации.");
  }
  if (status === 401) {
    return new AzureError("auth", 401, "Доступ отклонён (401): PAT неверный, истёк или не подходит к этой организации." + (message ? ` ${message}` : ""));
  }
  if (status === 403) {
    return new AzureError("forbidden", 403, `Недостаточно прав (403). ${message || "У PAT нет нужной области доступа."}`);
  }
  if (status === 404) {
    return new AzureError("not-found", 404, message || "Не найдено (404): проверьте организацию, коллекцию и проект.");
  }
  if (status === 400 && /api-version|out of range|not supported/i.test(message)) {
    return new AzureError("version", 400, message);
  }
  return new AzureError("http", status, `Azure ответил ${status}${message ? `: ${message}` : ""}`);
}

export class AzureClient {
  constructor(readonly cfg: AzureConfig, private readonly pat?: string, private readonly fetchImpl: typeof fetch = fetch) {}

  /** `path` is relative to `_apis`; the project segment is added unless `project: false`. */
  async request<T>(path: string, opts: { apiVersion?: string | null; project?: boolean } = {}): Promise<{ data: T; continuation?: string }> {
    const { baseUrl, project } = this.cfg;
    const version = opts.apiVersion === undefined ? this.cfg.apiVersion : opts.apiVersion;
    const prefix = opts.project === false ? "" : `/${encodeURIComponent(project)}`;
    let url = `${baseUrl}${prefix}/_apis/${path}`;
    if (version) url += `${url.includes("?") ? "&" : "?"}api-version=${version}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      // Makes Azure answer 401 instead of redirecting to the sign-in page.
      "X-TFS-FedAuthRedirect": "Suppress",
    };
    if (this.pat) headers.Authorization = `Basic ${Buffer.from(`:${this.pat}`).toString("base64")}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers, redirect: "manual", signal: AbortSignal.timeout(20_000) });
    } catch (err) {
      throw networkError(err, new URL(baseUrl).host);
    }
    const type = res.headers.get("content-type") ?? "";
    const text = await res.text();
    if (!res.ok || res.status === 203 || type.includes("text/html")) throw classifyHttp(res.status, type, text);
    try {
      return { data: JSON.parse(text) as T, continuation: res.headers.get("x-ms-continuationtoken") ?? undefined };
    } catch {
      throw new AzureError("http", res.status, "Azure вернул не JSON: проверьте адрес коллекции.");
    }
  }

  async get<T>(path: string, opts?: { apiVersion?: string | null; project?: boolean }): Promise<T> {
    return (await this.request<T>(path, opts)).data;
  }

  /** Follows x-ms-continuationtoken; stops at `max` items. */
  async list<T>(path: string, max = 2000): Promise<T[]> {
    const out: T[] = [];
    let token: string | undefined;
    do {
      const sep = path.includes("?") ? "&" : "?";
      const page = await this.request<{ value: T[] }>(token ? `${path}${sep}continuationToken=${encodeURIComponent(token)}` : path);
      out.push(...(page.data.value ?? []));
      token = page.continuation;
    } while (token && out.length < max);
    return out.slice(0, max);
  }
}

// ---- Connection check ----------------------------------------------------------------------

export interface CheckStep {
  id: string;
  title: string;
  ok: boolean | null; // null = skipped
  detail: string;
}

export interface CheckResult {
  ok: boolean;
  apiVersion?: string;
  user?: string;
  steps: CheckStep[];
}

/** Runs step by step so the tester sees exactly which part fails and which PAT scope is missing. */
export async function testConnection(base: Omit<AzureConfig, "apiVersion">, pat: string | undefined, fetchImpl: typeof fetch = fetch): Promise<CheckResult> {
  const steps: CheckStep[] = [];
  const step = (id: string, title: string, ok: boolean | null, detail: string) => steps.push({ id, title, ok, detail });
  const probe = new AzureClient({ ...base, apiVersion: "" }, pat, fetchImpl);

  // 1. Server reachable and PAT accepted. connectionData needs no api-version on every server version.
  let user: string | undefined;
  try {
    const cd = await probe.get<{ authenticatedUser?: { providerDisplayName?: string; customDisplayName?: string } }>(
      "connectionData", { project: false, apiVersion: null });
    user = cd.authenticatedUser?.customDisplayName ?? cd.authenticatedUser?.providerDisplayName;
    if (user && /anonymous/i.test(user)) user = undefined;
    // Public organizations silently treat an invalid PAT as anonymous instead of answering 401.
    if (pat && !user) step("server", "Сервер и авторизация", false, "Сервер доступен, но PAT не принят: Azure пустил вас анонимно. Проверьте PAT и организацию, для которой он выпущен.");
    else step("server", "Сервер и авторизация", true, user ? `Вход выполнен: ${user}` : "Сервер доступен, вход без PAT (анонимно): видны только публичные проекты.");
  } catch (err) {
    const e = err as AzureError;
    const detail = e.kind === "not-found"
      ? `Организация или коллекция не найдена (404): проверьте адрес ${base.baseUrl}.`
      : e.message;
    step("server", "Сервер и авторизация", false, detail);
    return { ok: false, steps };
  }
  const anonymous = !user;

  // 2. API version the server accepts.
  let apiVersion: string | undefined;
  let lastErr: AzureError | undefined;
  for (const v of API_VERSIONS) {
    try {
      await probe.get(`projects/${encodeURIComponent(base.project)}`, { project: false, apiVersion: v });
      apiVersion = v;
      break;
    } catch (err) {
      lastErr = err as AzureError;
      if (lastErr.kind !== "version") break;
    }
  }
  if (!apiVersion) {
    // Azure answers 401 rather than 404 for a missing project when the caller is anonymous.
    const detail = lastErr && ["not-found", "auth", "signin", "forbidden"].includes(lastErr.kind)
      ? `Проект «${base.project}» не найден или у вас нет к нему доступа.` +
        (anonymous ? " Без PAT видны только публичные проекты." : " Проверьте название и права пользователя PAT.")
      : lastErr?.message ?? "Сервер не принял ни одну версию API";
    step("project", "Проект", false, detail);
    return { ok: false, user, steps };
  }
  step("project", "Проект", true, `Проект «${base.project}» найден, версия API ${apiVersion}`);

  const client = new AzureClient({ ...base, apiVersion }, pat, fetchImpl);
  const scope = async (id: string, title: string, need: string, run: () => Promise<string>) => {
    try {
      step(id, title, true, await run());
    } catch (err) {
      const e = err as AzureError;
      const denied = e.kind === "forbidden" || e.kind === "auth" || e.kind === "signin";
      if (denied && anonymous) step(id, title, false, `Без PAT (анонимно) нет доступа. Задайте PAT с областью «${need}».`);
      else step(id, title, false, e.message + (denied ? ` Нужна область PAT «${need}».` : ""));
    }
  };
  await scope("wiki", "Wiki", "Wiki (Read)", async () => {
    const wikis = await client.list<{ name: string }>("wiki/wikis");
    return wikis.length ? `Вики: ${wikis.map((w) => w.name).join(", ")}` : "В проекте нет вики";
  });
  await scope("testplans", "Test Plans", "Test Management (Read)", async () => {
    const plans = await client.list<{ name: string }>("testplan/plans", 200);
    return plans.length ? `Тест-планов: ${plans.length}` : "В проекте нет тест-планов";
  });
  await scope("workitems", "Work Items (шаги кейсов)", "Work Items (Read)", async () => {
    await client.get("wit/workitemtypes");
    return "Типы рабочих элементов читаются";
  });

  return { ok: steps.every((s) => s.ok !== false), apiVersion, user, steps };
}

// ---- Wiki -----------------------------------------------------------------------------------

export interface WikiPage {
  path: string;
  order?: number;
  isParentPage?: boolean;
  subPages?: WikiPage[];
}

export const listWikis = (c: AzureClient) =>
  c.list<{ id: string; name: string; type: string }>("wiki/wikis");

export const wikiTree = (c: AzureClient, wikiId: string) =>
  c.get<WikiPage>(`wiki/wikis/${encodeURIComponent(wikiId)}/pages?path=%2F&recursionLevel=full`);

export async function wikiPage(c: AzureClient, wikiId: string, path: string) {
  const p = await c.get<{ path: string; content?: string; gitItemPath?: string; remoteUrl?: string }>(
    `wiki/wikis/${encodeURIComponent(wikiId)}/pages?path=${encodeURIComponent(path)}&includeContent=true`);
  return { path: p.path, content: p.content ?? "", url: p.remoteUrl };
}

// ---- Test Plans -----------------------------------------------------------------------------

export const listPlans = (c: AzureClient) =>
  c.list<{ id: number; name: string; state?: string; iteration?: string }>("testplan/plans", 500);

export const listSuites = (c: AzureClient, planId: number) =>
  c.list<{ id: number; name: string; suiteType?: string; parentSuite?: { id: number } }>(
    `testplan/Plans/${planId}/suites`, 2000);

export interface TestStep {
  kind: "step" | "shared";
  action: string;
  expected: string;
  sharedId?: number;
}

export interface TestCase {
  id: number;
  title: string;
  state: string;
  priority?: number;
  steps: TestStep[];
  url?: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : ENTITIES[e.toLowerCase()] ?? m);

/** Step texts are HTML escaped inside XML; turn them into plain lines. */
export function htmlToText(html: string): string {
  return decode(
    html
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h\d)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, ""),
  )
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Parses Microsoft.VSTS.TCM.Steps XML: action steps and shared-step references, in order. */
export function parseSteps(xml: string | undefined): TestStep[] {
  if (!xml) return [];
  const out: TestStep[] = [];
  const re = /<step\b[^>]*>([\s\S]*?)<\/step>|<compref\b[^>]*\bref="(\d+)"[^>]*>/gi;
  for (const m of xml.matchAll(re)) {
    if (m[2]) {
      out.push({ kind: "shared", action: `Общие шаги #${m[2]}`, expected: "", sharedId: Number(m[2]) });
      continue;
    }
    const parts = [...m[1].matchAll(/<parameterizedString\b[^>]*>([\s\S]*?)<\/parameterizedString>|<parameterizedString\b[^>]*\/>/gi)]
      .map((p) => htmlToText(decode(p[1] ?? "")));
    out.push({ kind: "step", action: parts[0] ?? "", expected: parts[1] ?? "" });
  }
  return out;
}

const CASE_FIELDS = ["System.Title", "System.State", "Microsoft.VSTS.Common.Priority", "Microsoft.VSTS.TCM.Steps"];

export async function listCases(c: AzureClient, planId: number, suiteId: number): Promise<TestCase[]> {
  const refs = await c.list<{ workItem: { id: number } }>(`testplan/Plans/${planId}/Suites/${suiteId}/TestCase`, 2000);
  const ids = refs.map((r) => r.workItem.id);
  const out: TestCase[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const batch = ids.slice(i, i + 200);
    const items = await c.list<{ id: number; fields: Record<string, unknown>; _links?: { html?: { href: string } } }>(
      `wit/workitems?ids=${batch.join(",")}&fields=${CASE_FIELDS.join(",")}`);
    for (const w of items) {
      out.push({
        id: w.id,
        title: String(w.fields["System.Title"] ?? ""),
        state: String(w.fields["System.State"] ?? ""),
        priority: w.fields["Microsoft.VSTS.Common.Priority"] as number | undefined,
        steps: parseSteps(w.fields["Microsoft.VSTS.TCM.Steps"] as string | undefined),
        url: `${c.cfg.baseUrl}/${encodeURIComponent(c.cfg.project)}/_workitems/edit/${w.id}`,
      });
    }
  }
  return out;
}
