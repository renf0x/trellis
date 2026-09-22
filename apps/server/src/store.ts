// Local copy of imported docs and cases in SQLite (node:sqlite, built into Node 22.13+, no native build).
// Docs are also mirrored as Markdown under data/obsidian/<source>/ so the folder opens as an Obsidian vault;
// the database stays the source of truth and the mirror is rewritten on every sync.
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { DataStore, DocRecord, SourceInfo, SourceSnapshot, TestCaseRecord } from "@trellis/core";

const SOURCE_RE = /^[a-z0-9][a-z0-9-]{0,60}$/;

const SCHEMA = `
create table if not exists sources (source text primary key, title text not null, synced_at text not null);
create table if not exists docs (
  id text primary key, source text not null, container text not null, path text not null,
  title text not null, content text not null, url text);
create table if not exists cases (
  id text primary key, source text not null, external_id text not null, title text not null,
  state text not null, priority integer, suites text not null, steps text not null, url text);
create index if not exists docs_source on docs(source);
create index if not exists cases_source on cases(source);
`;

/** Windows-safe file name segment. */
const segment = (s: string) => s.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "").slice(0, 120) || "_";

export class SqliteDataStore implements DataStore {
  private readonly db: DatabaseSync;

  constructor(file: string, private readonly mirrorDir?: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("pragma journal_mode = wal;");
    this.db.exec(SCHEMA);
  }

  async sources(): Promise<SourceInfo[]> {
    return this.db.prepare(`
      select s.source, s.title, s.synced_at as syncedAt,
        (select count(*) from docs d where d.source = s.source) as docs,
        (select count(*) from cases c where c.source = s.source) as cases
      from sources s order by s.source`).all() as unknown as SourceInfo[];
  }

  async docs(): Promise<DocRecord[]> {
    return (this.db.prepare("select * from docs order by container, path").all() as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), source: String(r.source), container: String(r.container), path: String(r.path),
      title: String(r.title), content: String(r.content), ...(r.url ? { url: String(r.url) } : {}),
    }));
  }

  async cases(): Promise<TestCaseRecord[]> {
    return (this.db.prepare("select * from cases order by source, cast(external_id as integer)").all() as Record<string, unknown>[]).map((r) => ({
      id: String(r.id), source: String(r.source), externalId: String(r.external_id), title: String(r.title),
      state: String(r.state), ...(r.priority != null ? { priority: Number(r.priority) } : {}),
      suites: JSON.parse(String(r.suites)), steps: JSON.parse(String(r.steps)),
      ...(r.url ? { url: String(r.url) } : {}),
    }));
  }

  async replace(s: SourceSnapshot) {
    if (!SOURCE_RE.test(s.source)) throw new Error(`bad source id ${s.source}`);
    const insDoc = this.db.prepare("insert or replace into docs values (?, ?, ?, ?, ?, ?, ?)");
    const insCase = this.db.prepare("insert or replace into cases values (?, ?, ?, ?, ?, ?, ?, ?, ?)");
    this.db.exec("begin");
    try {
      this.db.prepare("delete from docs where source = ?").run(s.source);
      this.db.prepare("delete from cases where source = ?").run(s.source);
      this.db.prepare("insert or replace into sources values (?, ?, ?)").run(s.source, s.title, s.syncedAt);
      for (const d of s.docs) insDoc.run(d.id, s.source, d.container, d.path, d.title, d.content, d.url ?? null);
      for (const c of s.cases) {
        insCase.run(c.id, s.source, c.externalId, c.title, c.state, c.priority ?? null,
          JSON.stringify(c.suites), JSON.stringify(c.steps), c.url ?? null);
      }
      this.db.exec("commit");
    } catch (err) {
      this.db.exec("rollback");
      throw err;
    }
    await this.mirror(s);
  }

  private async mirror(s: SourceSnapshot) {
    if (!this.mirrorDir) return;
    const root = join(this.mirrorDir, s.source);
    await rm(root, { recursive: true, force: true });
    for (const d of s.docs) {
      const parts = d.path.split("/").filter(Boolean).map(segment);
      // A page that has children in the wiki becomes Folder.md next to Folder/.
      const file = join(root, segment(d.container), ...(parts.length ? parts : ["index"])) + ".md";
      await mkdir(dirname(file), { recursive: true });
      const header = d.url ? `---\nsource: ${s.source}\nurl: ${d.url}\n---\n\n` : "";
      await writeFile(file, header + d.content, "utf8");
    }
  }
}
