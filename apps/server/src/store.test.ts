import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SqliteDataStore } from "./store.ts";

test("replace swaps one source and mirrors docs as Markdown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trellis-store-"));
  try {
    const store = new SqliteDataStore(join(dir, "t.db"), join(dir, "obsidian"));
    const doc = { id: "azure-devops:W:/A/B", source: "azure-devops", container: "W", path: "/A/B", title: "B", content: "# B", url: "https://x" };
    const tc = { id: "azure-devops:7", source: "azure-devops", externalId: "7", title: "Login", state: "Ready",
      priority: 2, suites: ["Plan / Auth"], steps: [{ kind: "step" as const, action: "Open", expected: "Form" }] };
    await store.replace({ source: "azure-devops", title: "Azure", syncedAt: "2026-09-22T00:00:00Z", docs: [doc], cases: [tc] });
    await store.replace({ source: "local-files", title: "Local", syncedAt: "2026-09-22T00:00:00Z", docs: [], cases: [] });
    assert.deepEqual(await store.docs(), [doc]);
    assert.deepEqual(await store.cases(), [tc]);
    assert.equal((await store.sources()).find((s) => s.source === "azure-devops")?.cases, 1);
    assert.match(await readFile(join(dir, "obsidian", "azure-devops", "W", "A", "B.md"), "utf8"), /url: https:\/\/x[\s\S]*# B/);

    await store.replace({ source: "azure-devops", title: "Azure", syncedAt: "2026-09-23T00:00:00Z", docs: [], cases: [] });
    assert.deepEqual(await store.cases(), []);
    await assert.rejects(store.replace({ source: "../x", title: "", syncedAt: "", docs: [], cases: [] }));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});
