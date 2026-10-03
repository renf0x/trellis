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
