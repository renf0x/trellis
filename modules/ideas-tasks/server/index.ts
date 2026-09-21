import { HttpError, type ServerModuleContext } from "@trellis/core";

// Stage 2 moves these into the configurable dictionaries engine.
const STATUSES = ["idea", "in-progress", "done", "rejected"];
const ID_RE = /^IDEA-\d{8}-\d{3}$/;

function text(v: unknown, field: string, max: number, required = false): string | undefined {
  if (v === undefined || v === null || v === "") {
    if (required) throw new HttpError(400, `${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  const s = v.trim();
  if (s.length > max) throw new HttpError(400, `${field} is longer than ${max}`);
  return s;
}

export function register(ctx: ServerModuleContext) {
  ctx.route("GET", "/ideas", async ({ query }) => {
    const status = query.status?.split(",").filter((s) => STATUSES.includes(s));
    const entries = await ctx.memory.list({ type: ["IDEA"], status: status?.length ? status : undefined });
    // IDs sort by date and sequence, so descending order puts the newest first.
    entries.sort((a, b) => b.id.localeCompare(a.id));
    return { statuses: STATUSES, entries };
  });

  ctx.route("POST", "/ideas", async ({ body }) => {
    const b = (body ?? {}) as Record<string, unknown>;
    const title = text(b.title, "title", 200, true)!;
    const fields: Record<string, string> = { Author: text(b.author, "author", 80) ?? "user", Source: "ui" };
    const summary = text(b.summary, "summary", 4000);
    if (summary) fields.Summary = summary;
    return ctx.memory.add("IDEA", { title, fields });
  });

  ctx.route("PATCH", "/ideas/:id", async ({ params, body }) => {
    if (!ID_RE.test(params.id)) throw new HttpError(400, "bad idea id");
    const b = (body ?? {}) as Record<string, unknown>;
    const status = text(b.status, "status", 40);
    if (status && !STATUSES.includes(status)) throw new HttpError(400, `unknown status ${status}`);
    const title = text(b.title, "title", 200);
    return ctx.memory.update(params.id, { status, title });
  });
}
