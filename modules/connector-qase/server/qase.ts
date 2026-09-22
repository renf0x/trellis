// Qase REST API v1 client (read only). Auth: header `Token: <API token>`.
// Docs: https://developers.qase.io — list endpoints page with limit (max 100) and offset.

export class QaseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export const DEFAULT_HOST = "https://api.qase.io";
const TIMEOUT_MS = 20_000;
const PAGE = 100;

/** Accepts `api.qase.io`, a full URL, or an app link; returns the API origin. */
export function normalizeHost(raw: string): string {
  let s = raw.trim();
  if (!s) return DEFAULT_HOST;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  const u = new URL(s);
  if (u.protocol !== "https:") throw new Error("Нужен адрес https://");
  // The web app lives on app.qase.io, the API on api.qase.io.
  if (u.hostname === "app.qase.io" || u.hostname === "qase.io") return DEFAULT_HOST;
  return u.origin;
}

/** Link to a case in the web app (works for the cloud; self-hosted keeps its own host). */
export function caseUrl(host: string, code: string, id: number) {
  const app = host === DEFAULT_HOST ? "https://app.qase.io" : host.replace("//api.", "//app.");
  return `${app}/case/${code}-${id}`;
}

function explain(status: number, body: string): string {
  let msg = "";
  try {
    const j = JSON.parse(body);
    msg = j.errorMessage ?? j.message ?? (j.errorFields ? JSON.stringify(j.errorFields) : "");
  } catch {
    msg = body.slice(0, 200);
  }
  if (status === 401) return "401: токен не подходит. Создайте API-токен в Qase: аватар → API tokens";
  if (status === 403) return `403: у токена нет доступа${msg ? ` (${msg})` : ""}`;
  if (status === 404) return `404: не найдено${msg ? ` (${msg})` : ""}. Проверьте код проекта`;
  if (status === 429) return "429: превышен лимит запросов Qase, попробуйте через минуту";
  return `${status}: ${msg || "ошибка Qase"}`;
}

export class QaseClient {
  constructor(readonly host: string, private readonly token: string | undefined, private readonly fetchImpl: typeof fetch = fetch) {}

  get hasToken() {
    return !!this.token;
  }

  async get<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
    if (!this.token) throw new QaseError(401, "Укажите API-токен Qase");
    const url = new URL(`/v1/${path.replace(/^\//, "")}`, this.host);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          headers: { Token: this.token, Accept: "application/json" },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (e) {
        const err = e as Error & { cause?: { code?: string } };
        if (err.name === "TimeoutError") throw new QaseError(0, "Qase не ответил за 20 секунд");
        throw new QaseError(0, `Нет связи с ${url.host}: ${err.cause?.code ?? err.message}`);
      }
      if (res.status === 429 && attempt < 2) {
        const wait = Math.min(Number(res.headers.get("retry-after")) || 5, 30);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }
      const text = await res.text();
      if (!res.ok) throw new QaseError(res.status, explain(res.status, text));
      const body = JSON.parse(text) as { status: boolean; result: T; errorMessage?: string };
      if (body.status === false) throw new QaseError(400, body.errorMessage ?? "Qase вернул ошибку");
      return body.result;
    }
  }

  /** Reads every page of a list endpoint. */
  async all<T>(path: string, onPage?: (n: number) => void, max = 20_000): Promise<T[]> {
    const out: T[] = [];
    for (let offset = 0; out.length < max; offset += PAGE) {
      const r = await this.get<{ total: number; count: number; entities: T[] }>(path, { limit: PAGE, offset });
      out.push(...r.entities);
      onPage?.(out.length);
      if (r.entities.length < PAGE || out.length >= r.total) break;
    }
    return out;
  }
}

export interface QaseStep { position?: number; action?: string; expected_result?: string; data?: string; steps?: QaseStep[] }
export interface QaseCase {
  id: number;
  title: string;
  description?: string | null;
  preconditions?: string | null;
  postconditions?: string | null;
  priority?: number | string | null;
  severity?: number | string | null;
  status?: number | string | null;
  suite_id?: number | null;
  steps?: QaseStep[];
}
export interface QaseSuite { id: number; title: string; parent_id?: number | null; description?: string | null; preconditions?: string | null }
export interface QaseProject { title: string; code: string; counts?: { cases?: number; suites?: number } }

/** Flattens nested steps (Qase allows sub-steps) in order. */
export function flattenSteps(steps: QaseStep[] = []): { action: string; expected: string }[] {
  const out: { action: string; expected: string }[] = [];
  const walk = (list: QaseStep[], prefix: string) => {
    [...list].sort((a, b) => (a.position ?? 0) - (b.position ?? 0)).forEach((s, i) => {
      const data = s.data?.trim() ? `\nДанные: ${s.data.trim()}` : "";
      out.push({ action: `${prefix}${(s.action ?? "").trim()}${data}`.trim(), expected: (s.expected_result ?? "").trim() });
      if (s.steps?.length) walk(s.steps, `${prefix}${i + 1}.`);
    });
  };
  walk(steps, "");
  return out.filter((s) => s.action || s.expected);
}

/** "Parent / Child" path for every suite id. */
export function suitePaths(suites: QaseSuite[]): Map<number, string> {
  const byId = new Map(suites.map((s) => [s.id, s]));
  const paths = new Map<number, string>();
  const path = (id: number, seen = new Set<number>()): string => {
    if (paths.has(id)) return paths.get(id)!;
    const s = byId.get(id);
    if (!s || seen.has(id)) return "";
    seen.add(id);
    const parent = s.parent_id ? path(s.parent_id, seen) : "";
    const p = parent ? `${parent} / ${s.title}` : s.title;
    paths.set(id, p);
    return p;
  };
  for (const s of suites) path(s.id);
  return paths;
}

export interface CheckStep { id: string; title: string; ok: boolean; message: string }
export interface CheckResult { ok: boolean; steps: CheckStep[]; project?: string }

export async function testConnection(c: QaseClient, code: string): Promise<CheckResult> {
  const steps: CheckStep[] = [];
  const done = (project?: string) => ({ ok: steps.every((s) => s.ok), steps, project });
  try {
    const r = await c.get<{ total: number }>("project", { limit: 1 });
    steps.push({ id: "auth", title: "Токен", ok: true, message: `Принят, доступно проектов: ${r.total}` });
  } catch (e) {
    steps.push({ id: "auth", title: "Токен", ok: false, message: (e as Error).message });
    return done();
  }
  try {
    const p = await c.get<QaseProject>(`project/${code}`);
    const n = p.counts?.cases;
    steps.push({ id: "project", title: "Проект", ok: true, message: `${p.title} (${p.code})${n !== undefined ? ` · кейсов: ${n}` : ""}` });
    return done(p.title);
  } catch (e) {
    steps.push({ id: "project", title: "Проект", ok: false, message: (e as Error).message });
    return done();
  }
}
