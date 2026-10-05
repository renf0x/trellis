import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ChatStore } from "./chats.ts";

test("conversations are saved per bucket, titled by the first question and listed newest first", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trellis-chats-"));
  try {
    const s = new ChatStore(dir);
    await s.save("main", "a", { messages: [{ role: "user", content: "Почему кейс   устарел?" }, { role: "assistant", content: "Потому что" }] });
    await new Promise((r) => setTimeout(r, 5));
    await s.save("main", "b", { messages: [{ role: "user", content: "Второй" }] });
    const list = await s.list("main");
    assert.deepEqual(list.map((c) => [c.id, c.title, c.count]), [["b", "Второй", 1], ["a", "Почему кейс устарел?", 2]]);
    assert.deepEqual(await s.list("dev"), []);
    await s.remove("main", "a");
    assert.equal((await s.get("main", "a")), null);
    await assert.rejects(s.save("main", "c", { messages: [{ role: "system", content: "x" }] }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("workbench chat keeps a report subject, the open tab flag and unsent context", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trellis-chats-"));
  try {
    const s = new ChatStore(dir);
    const subject = { kind: "finding", key: "finding:f1", title: "Вход в систему" };
    const pending = [{ id: "a", title: "Находка", text: "контекст" }];
    // A fresh tab has no messages yet, only the report.
    const meta = await s.save("work", "t1", { title: subject.title, subject, open: true, pending, messages: [] });
    assert.deepEqual([meta.title, meta.count, meta.open, meta.subject?.key], ["Вход в систему", 0, true, "finding:f1"]);
    assert.deepEqual((await s.get("work", "t1"))?.pending, pending);
    // Closing the tab keeps subject and history; the pending context is gone once sent.
    await s.save("work", "t1", { open: false, messages: [{ role: "user", content: "Почему?" }] });
    const c = await s.get("work", "t1");
    assert.deepEqual([c?.open, c?.subject?.key, c?.pending, c?.title], [false, "finding:f1", undefined, "Вход в систему"]);
    assert.deepEqual((await s.list("work")).map((x) => [x.id, x.open]), [["t1", false]]);
    assert.deepEqual(await s.list("main"), []);
    await assert.rejects(s.save("work", "t2", { subject: { kind: "x" }, messages: [] }));
    await assert.rejects(s.save("work", "t2", { open: "yes", messages: [] }));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
