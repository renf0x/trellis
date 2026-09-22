import { HttpError, type ServerModuleContext } from "@trellis/core";

export function register(ctx: ServerModuleContext) {
  ctx.route("GET", "/docs", async ({ query }) => {
    const q = (query.q ?? "").trim().toLowerCase().slice(0, 200);
    const docs = await ctx.data.docs();
    const items = docs
      .filter((d) => !q || d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q))
      .map(({ id, source, container, path, title }) => ({ id, source, container, path, title }));
    return { sources: await ctx.data.sources(), total: docs.length, items };
  });

  ctx.route("GET", "/doc", async ({ query }) => {
    const doc = (await ctx.data.docs()).find((d) => d.id === query.id);
    if (!doc) throw new HttpError(404, "Документ не найден: загрузите данные заново");
    return doc;
  });
}
