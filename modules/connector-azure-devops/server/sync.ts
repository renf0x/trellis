// Pulls every wiki page and every test case of the project into a normalized snapshot.
import type { DocRecord, SourceSnapshot, TestCaseRecord } from "@trellis/core";
import { listCases, listPlans, listSuites, listWikis, wikiPage, wikiTree, type AzureClient, type WikiPage } from "./azure.ts";

export const SOURCE = "azure-devops";

export interface SyncProgress {
  phase: "wiki" | "testplans" | "saving" | "done" | "error";
  message: string;
  docs: number;
  cases: number;
  warnings: string[];
}

const MAX_PAGES = 5000;

/** Runs `fn` over items with a small concurrency limit so Azure does not throttle us. */
async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

const flatten = (p: WikiPage): string[] => [p.path, ...(p.subPages ?? []).flatMap(flatten)];

export async function syncAzure(c: AzureClient, progress: SyncProgress): Promise<SourceSnapshot> {
  const { baseUrl, project } = c.cfg;
  const warn = (m: string) => progress.warnings.push(m);
  const docs: DocRecord[] = [];

  progress.phase = "wiki";
  const wikis = await listWikis(c).catch((e: Error) => (warn(`Wiki: ${e.message}`), []));
  for (const w of wikis) {
    progress.message = `Wiki «${w.name}»: дерево страниц`;
    let paths: string[];
    try {
      paths = flatten(await wikiTree(c, w.id)).filter((p) => p !== "/").slice(0, MAX_PAGES);
    } catch (e) {
      warn(`Wiki «${w.name}»: ${(e as Error).message}`);
      continue;
    }
    await pool(paths, 4, async (path) => {
      try {
        const page = await wikiPage(c, w.id, path);
        docs.push({
          id: `${SOURCE}:${w.name}:${path}`, source: SOURCE, container: w.name, path,
          title: path.split("/").pop() || path, content: page.content, ...(page.url ? { url: page.url } : {}),
        });
        progress.docs = docs.length;
        progress.message = `Wiki «${w.name}»: ${docs.length} стр.`;
      } catch (e) {
        warn(`Страница ${w.name}${path}: ${(e as Error).message}`);
      }
    });
  }

  progress.phase = "testplans";
  const cases = new Map<number, TestCaseRecord>();
  const plans = await listPlans(c).catch((e: Error) => (warn(`Test Plans: ${e.message}`), []));
  for (const plan of plans) {
    progress.message = `План «${plan.name}»: наборы`;
    let suites: Awaited<ReturnType<typeof listSuites>>;
    try {
      suites = await listSuites(c, plan.id);
    } catch (e) {
      warn(`План «${plan.name}»: ${(e as Error).message}`);
      continue;
    }
    const byId = new Map(suites.map((s) => [s.id, s]));
    const suitePath = (id: number): string => {
      const names: string[] = [];
      for (let s = byId.get(id); s; s = s.parentSuite ? byId.get(s.parentSuite.id) : undefined) {
        // The root suite carries the plan name; keep it once.
        if (s.parentSuite) names.unshift(s.name);
      }
      return [plan.name, ...names].join(" / ");
    };
    await pool(suites, 3, async (suite) => {
      try {
        for (const tc of await listCases(c, plan.id, suite.id)) {
          const path = suitePath(suite.id);
          const prev = cases.get(tc.id);
          if (prev) {
            if (!prev.suites.includes(path)) prev.suites.push(path);
            continue;
          }
          cases.set(tc.id, {
            id: `${SOURCE}:${tc.id}`, source: SOURCE, externalId: String(tc.id), title: tc.title, state: tc.state,
            ...(tc.priority !== undefined ? { priority: tc.priority } : {}),
            suites: [path], steps: tc.steps.map(({ kind, action, expected }) => ({ kind, action, expected })),
            ...(tc.url ? { url: tc.url } : {}),
          });
        }
        progress.cases = cases.size;
        progress.message = `План «${plan.name}»: ${cases.size} кейсов`;
      } catch (e) {
        warn(`Набор «${suite.name}»: ${(e as Error).message}`);
      }
    });
  }

  return {
    source: SOURCE,
    title: `Azure DevOps · ${project} (${new URL(baseUrl).host}${new URL(baseUrl).pathname.replace(/\/$/, "")})`,
    syncedAt: new Date().toISOString(),
    docs,
    cases: [...cases.values()],
  };
}
