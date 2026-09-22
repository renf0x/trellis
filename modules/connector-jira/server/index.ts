import { HttpError, type DocRecord, type ServerModuleContext, type TestCaseRecord } from "@trellis/core";
import {
  JiraClient,
  JiraError,
  isCloud,
  normalizeBaseUrl,
  searchAll,
  stepsFromDescription,
  testConnection,
  wikiToMarkdown,
  type CheckResult,
  type JiraIssue,
} from "./jira.ts";

export const SOURCE = "jira";

interface Settings {
  baseUrl: string;
  email: string;
  project: string;
  /** Issues that become documentation (requirements, stories). */
  docsJql: string;
  /** Issues that become test cases; empty = none. */
  casesJql: string;
  lastCheck?: CheckResult & { at: string };
}
interface Job { phase: "docs" | "cases" | "saving" | "done" | "error"; message: string; docs: number; cases: number; warnings: string[]; running: boolean; startedAt: string }

const KEY_RE = /^[A-Z][A-Z0-9_]{0,49}$/;
const defaultDocsJql = (p: string) => (p ? `project = ${p} ORDER BY key` : "");

function str(v: unknown, field: string, max = 300): string {
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is longer than ${max}`);
  return s;
}

const issueUrl = (base: string, key: string) => `${base}/browse/${key}`;

export function toDoc(base: string, i: JiraIssue): DocRecord {
  const f = i.fields;
  const project = f.project?.key ?? i.key.split("-")[0];
  const meta = [f.issuetype?.name, f.status?.name, f.labels?.length ? `метки: ${f.labels.join(", ")}` : ""].filter(Boolean).join(" · ");
  return {
    id: `${SOURCE}:${i.key}`, source: SOURCE, container: `${project} · ${f.issuetype?.name ?? "Задачи"}`,
    path: `/${i.key} ${f.summary ?? ""}`.trim(), title: `${i.key} ${f.summary ?? ""}`.trim(),
    content: `*${meta}*\n\n${wikiToMarkdown(f.description)}`, url: issueUrl(base, i.key),
  };
}

export function toCase(base: string, i: JiraIssue): TestCaseRecord {
  const f = i.fields;
  const project = f.project?.key ?? i.key.split("-")[0];
  const groups = f.components?.length ? f.components.map((c) => `${project} / ${c.name}`) : [project];
  const p = Number(f.priority?.id);
  return {
    id: `${SOURCE}:${i.key}`, source: SOURCE, externalId: i.key, title: f.summary ?? i.key, state: f.status?.name ?? "",
    ...(Number.isInteger(p) && p > 0 && p < 10 ? { priority: p } : {}),
    suites: groups, steps: stepsFromDescription(f.description), url: issueUrl(base, i.key),
  };
}

export function register(ctx: ServerModuleContext) {
  const settings = async (): Promise<Settings> =>
    ({ baseUrl: "", email: "", project: "", docsJql: "", casesJql: "", ...(await ctx.files.read<Settings>("settings")) });
  const token = async () => process.env.JIRA_TOKEN || (await ctx.secrets.get()).token || undefined;
  const client = async (s?: Settings) => {
    s ??= await settings();
    if (!s.baseUrl || !s.project) throw new HttpError(400, "Jira не настроена: укажите адрес и ключ проекта");
    return new JiraClient({ baseUrl: s.baseUrl, email: s.email || undefined }, await token());
  };

  ctx.route("GET", "/settings", async () => {
    const s = await settings();
    const t = await token();
    return { ...s, cloud: s.baseUrl ? isCloud(s.baseUrl) : null, hasToken: !!t, tokenHint: t ? `…${t.slice(-4)}` : undefined, tokenFromEnv: !!process.env.JIRA_TOKEN };
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
    if (b.project !== undefined) {
      const p = str(b.project, "project", 50).toUpperCase();
      if (p && !KEY_RE.test(p)) throw new HttpError(400, "Ключ проекта: латиница и цифры, например QA");
      if (!next.docsJql || next.docsJql === defaultDocsJql(next.project)) next.docsJql = defaultDocsJql(p);
      next.project = p;
    }
    if (b.docsJql !== undefined) next.docsJql = str(b.docsJql, "docsJql", 2000) || defaultDocsJql(next.project);
    if (b.casesJql !== undefined) next.casesJql = str(b.casesJql, "casesJql", 2000);
    if (b.token !== undefined) await ctx.secrets.set({ token: str(b.token, "token", 500) || null });
    delete next.lastCheck;
    await ctx.files.write("settings", next);
    return { ok: true, baseUrl: next.baseUrl };
  });

  ctx.route("POST", "/test", async () => {
    const s = await settings();
    if (!s.baseUrl || !s.project) throw new HttpError(400, "Укажите адрес Jira и ключ проекта");
    const result = await testConnection(await client(s), s.project, { docs: s.docsJql || defaultDocsJql(s.project), cases: s.casesJql });
    if (!(await token())) {
      for (const st of result.steps) if (!st.ok && /401|403/.test(st.message)) st.message = "Без токена (анонимно) это недоступно: укажите токен.";
    }
    await ctx.files.write("settings", { ...s, lastCheck: { ...result, at: new Date().toISOString() } });
    ctx.log(`jira check ${result.ok ? "ok" : "failed"}: ${result.steps.map((x) => `${x.id}=${x.ok}`).join(" ")}`);
    return result;
  });

  let job: Job | null = null;
  ctx.route("GET", "/sync", async () => ({ job, source: (await ctx.data.sources()).find((x) => x.source === SOURCE) ?? null }));
  ctx.route("POST", "/sync", async () => {
    if (job?.running) throw new HttpError(409, "Загрузка уже идёт");
    const s = await settings();
    const c = await client(s);
    const current: Job = { phase: "docs", message: "Документация", docs: 0, cases: 0, warnings: [], running: true, startedAt: new Date().toISOString() };
    job = current;
    void (async () => {
      try {
        const docs: DocRecord[] = [];
        const cases: TestCaseRecord[] = [];
        const caseKeys = new Set<string>();
        if (s.casesJql) {
          current.phase = "cases";
          try {
            for (const i of await searchAll(c, s.casesJql, 5000, (n) => ((current.cases = n), (current.message = `Тест-кейсы: ${n}`)))) {
              cases.push(toCase(s.baseUrl, i));
              caseKeys.add(i.key);
            }
          } catch (e) {
            current.warnings.push(`Тест-кейсы: ${(e as Error).message}`);
          }
        }
        current.phase = "docs";
        try {
          const jql = s.docsJql || defaultDocsJql(s.project);
          // An issue picked up as a test case is not documentation too.
          for (const i of await searchAll(c, jql, 5000, (n) => ((current.docs = n), (current.message = `Документация: ${n}`)))) {
            if (!caseKeys.has(i.key)) docs.push(toDoc(s.baseUrl, i));
          }
        } catch (e) {
          current.warnings.push(`Документация: ${(e as Error).message}`);
        }
        if (!docs.length && !cases.length && current.warnings.length) {
          throw new Error("Ничего не загружено, прежние данные сохранены. " + current.warnings[0]);
        }
        current.phase = "saving";
        await ctx.data.replace({ source: SOURCE, title: `Jira · ${s.project}`, syncedAt: new Date().toISOString(), docs, cases });
        current.docs = docs.length;
        current.cases = cases.length;
        current.phase = "done";
        current.message = `Загружено: ${docs.length} задач в документацию, ${cases.length} тест-кейсов`;
      } catch (e) {
        current.phase = "error";
        current.message = (e as Error).message;
      } finally {
        current.running = false;
        ctx.log(`jira sync ${current.phase}: docs=${current.docs} cases=${current.cases} warnings=${current.warnings.length}`);
      }
    })();
    return current;
  });

  ctx.route("GET", "/issues", async ({ query }) => {
    const s = await settings();
    const jql = str(query.jql ?? s.docsJql ?? "", "jql", 2000);
    if (!jql) throw new HttpError(400, "Пустой JQL");
    try {
      const c = await client(s);
      const r = await c.get<{ issues: JiraIssue[] }>(isCloud(s.baseUrl) ? "search/jql" : "search",
        { jql, fields: "summary,status,issuetype", maxResults: 50 });
      return r.issues.map((i) => ({ key: i.key, summary: i.fields.summary, status: i.fields.status?.name, type: i.fields.issuetype?.name, url: issueUrl(s.baseUrl, i.key) }));
    } catch (e) {
      if (e instanceof JiraError) throw new HttpError(e.status === 400 ? 400 : 502, e.message);
      throw e;
    }
  });
}
