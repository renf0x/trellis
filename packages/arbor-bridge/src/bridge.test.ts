import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ArborBridge, ArborError } from "./index.ts";

const script = resolve(fileURLToPath(import.meta.url), "../../../../arbor.py");

test("add -> list -> update -> close -> check -> delete", async () => {
  const root = await mkdtemp(join(tmpdir(), "trellis-vault-"));
  try {
    const arbor = new ArborBridge({ root, script });
    assert.equal(arbor.initialized, false);
    await arbor.init();
    assert.equal(arbor.initialized, true);

    const idea = await arbor.add("IDEA", {
      title: "Сравнение \"кавычек\" & спецсимволов",
      fields: { Author: "user", Proposal: "строка 1\nстрока 2" },
    });
    assert.match(idea.id, /^IDEA-\d{8}-001$/);

    const listed = await arbor.list({ type: ["IDEA"], status: ["idea"] });
    assert.deepEqual(listed.map((e) => e.title), ["Сравнение \"кавычек\" & спецсимволов"]);

    await arbor.update(idea.id, { status: "in-progress" });
    assert.equal((await arbor.get(idea.id)).status, "in-progress");
    assert.equal((await arbor.get(idea.id)).fields.Proposal, "строка 1\nстрока 2");

    await arbor.close(idea.id, "done");
    assert.equal((await arbor.check()).ok, true);

    await arbor.delete(idea.id);
    await assert.rejects(arbor.get(idea.id), ArborError);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
