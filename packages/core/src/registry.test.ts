import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { EventBus, validateManifest } from "./index.ts";
import { loadModules } from "./node.ts";

const good = {
  id: "docs-view",
  title: "Документация",
  version: "0.1.0",
  slots: [{ slot: "sidebar", section: "work", order: 10 }],
  permissions: ["sources:read"],
};

test("validateManifest accepts a valid manifest", () => {
  assert.equal(validateManifest(good).ok, true);
});

test("validateManifest rejects bad slots, permissions and escaping paths", () => {
  const res = validateManifest({
    ...good,
    id: "Bad Id",
    slots: [{ slot: "nowhere", section: "x" }],
    permissions: ["root"],
    ui: "../../core/evil.tsx",
  });
  assert.equal(res.ok, false);
  const paths = res.ok ? [] : res.issues.map((i) => i.path);
  assert.deepEqual(paths.sort(), ["id", "permissions[0]", "slots[0].section", "slots[0].slot", "ui"].sort());
});

test("loadModules reports broken modules without failing the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "trellis-mods-"));
  try {
    await mkdir(join(root, "docs-view"));
    await writeFile(join(root, "docs-view", "module.json"), JSON.stringify(good));
    await mkdir(join(root, "broken"));
    await writeFile(join(root, "broken", "module.json"), "{not json");
    await mkdir(join(root, "mismatch"));
    await writeFile(join(root, "mismatch", "module.json"), JSON.stringify({ ...good, id: "other" }));
    await mkdir(join(root, "empty"));

    const snap = await loadModules(root, { disabled: ["docs-view"] });
    assert.deepEqual(snap.modules.map((m) => [m.manifest.id, m.enabled]), [["docs-view", false]]);
    assert.deepEqual(snap.errors.map((e) => e.dir).sort(), ["broken", "empty", "mismatch"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("EventBus isolates failing handlers", () => {
  const bus = new EventBus<{ ping: number }>();
  const seen: number[] = [];
  bus.on("ping", () => {
    throw new Error("boom");
  });
  const off = bus.on("ping", (n) => seen.push(n));
  const origError = console.error;
  console.error = () => {};
  try {
    bus.emit("ping", 1);
    off();
    bus.emit("ping", 2);
  } finally {
    console.error = origError;
  }
  assert.deepEqual(seen, [1]);
});

test("validateManifest checks chat contributions: channel and own routes only", () => {
  const chat = [{ channel: "main", prompt: "Идеи", actions: [{ id: "save-idea", label: "В идеи", post: "/api/m/docs-view/ideas" }] }];
  assert.equal(validateManifest({ ...good, chat }).ok, true);
  const res = validateManifest({
    ...good,
    chat: [{ channel: "nowhere", actions: [{ id: "x", label: "", post: "/api/m/other/ideas" }] }],
  });
  assert.equal(res.ok, false);
  const paths = res.ok ? [] : res.issues.map((i) => i.path);
  assert.deepEqual(paths, ["chat[0].channel", "chat[0].actions[0].label", "chat[0].actions[0].post"]);
});
