import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backupsDir, DataTooNewError, migrateData, readDataVersion, restoreData } from "./migrate.ts";

async function withData(fn: (data: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "trellis-mig-"));
  try {
    const data = join(dir, "data");
    await mkdir(join(data, "config"), { recursive: true });
    await writeFile(join(data, "config", "llm.json"), '{"old":true}');
    await fn(data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("unversioned data is format 1 and is only stamped, not copied", async () => withData(async (data) => {
  const r = await migrateData(data);
  assert.equal(r.applied.length, 0);
  assert.equal((await readDataVersion(data))?.version, 1);
  assert.deepEqual(await readdir(backupsDir(data)).catch(() => []), []);
}));

test("a pending migration runs after a full backup and is recorded", async () => withData(async (data) => {
  const migrations = [{ to: 2, title: "rename", run: async (d: string) => writeFile(join(d, "config", "llm.json"), '{"new":true}') }];
  const r = await migrateData(data, () => {}, { migrations, target: 2 });
  assert.deepEqual([r.from, r.to], [1, 2]);
  assert.ok(r.backup);
  assert.equal(await readFile(join(r.backup!, "config", "llm.json"), "utf8"), '{"old":true}');
  assert.equal(await readFile(join(data, "config", "llm.json"), "utf8"), '{"new":true}');
  const v = await readDataVersion(data);
  assert.equal(v?.version, 2);
  assert.deepEqual(v?.history.map((h) => [h.from, h.to]), [[1, 2]]);
  // Second start: nothing to do.
  assert.equal((await migrateData(data, () => {}, { migrations, target: 2 })).applied.length, 0);
  // Restore brings the old file back and keeps a copy of what was there.
  await restoreData(data, r.backup!);
  assert.equal(await readFile(join(data, "config", "llm.json"), "utf8"), '{"old":true}');
  assert.ok((await readdir(backupsDir(data))).some((n) => n.endsWith("before-restore")));
}));

test("data from a newer app version is refused, not opened", async () => withData(async (data) => {
  await writeFile(join(data, "VERSION.json"), JSON.stringify({ version: 5, history: [] }));
  await assert.rejects(migrateData(data), DataTooNewError);
}));
