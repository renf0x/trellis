import { HttpError, type ServerModuleContext } from "@trellis/core";

export function register(ctx: ServerModuleContext) {
  ctx.route("GET", "/cases", async ({ query }) => {
    const q = (query.q ?? "").trim().toLowerCase().slice(0, 200);
    const all = await ctx.data.cases();
    const items = all
      .filter((c) => !query.state || c.state === query.state)
      .filter((c) => !query.suite || c.suites.some((s) => s === query.suite || s.startsWith(`${query.suite} / `)))
      .filter((c) => !q || c.externalId === q || c.title.toLowerCase().includes(q) ||
        c.steps.some((s) => s.action.toLowerCase().includes(q) || s.expected.toLowerCase().includes(q)))
      .map(({ steps, ...c }) => ({ ...c, stepCount: steps.length, noExpected: steps.some((s) => s.kind === "step" && !s.expected) }));
    return {
      sources: await ctx.data.sources(),
      total: all.length,
      states: [...new Set(all.map((c) => c.state))].sort(),
      suites: [...new Set(all.flatMap((c) => c.suites))].sort(),
      items,
    };
  });

  ctx.route("GET", "/case", async ({ query }) => {
    const c = (await ctx.data.cases()).find((x) => x.id === query.id);
    if (!c) throw new HttpError(404, "Кейс не найден: загрузите данные заново");
    return c;
  });
}
