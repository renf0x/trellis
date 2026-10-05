import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { ProxyAgent, Socks5ProxyAgent } from "undici";
import { parseProxyUrl, proxiedFetch, proxyAgent, proxyHint } from "./proxy.ts";

const listen = (s: Server) => new Promise<number>((ok) => s.listen(0, "127.0.0.1", () => ok((s.address() as AddressInfo).port)));

test("proxy URLs: schemes, defaults and a hint without the login", () => {
  assert.equal(parseProxyUrl("socks5h://u:p@h:1080").protocol, "socks5:");
  assert.equal(parseProxyUrl(" socks://h ").protocol, "socks5:");
  assert.throws(() => parseProxyUrl("ftp://h:21"), /http:\/\/, https:\/\/ или socks5/);
  assert.throws(() => parseProxyUrl("прокси без схемы"), /не разобран/);
  assert.equal(proxyHint("socks5://user:secret@de.example:1080"), "socks5://de.example:1080 (с логином)");
  assert.equal(proxyHint("http://10.0.0.1"), "http://10.0.0.1:80");
  assert.ok(!proxyHint("https://user:secret@h").includes("secret"));
  assert.ok(proxyAgent("socks5://h:1080") instanceof Socks5ProxyAgent);
  assert.ok(proxyAgent("http://h:3128") instanceof ProxyAgent);
});

test("proxiedFetch tunnels through an HTTP proxy with its login", async () => {
  const target = createServer((_req, res) => res.end(JSON.stringify({ via: "target" })));
  const tPort = await listen(target);
  let auth = "";
  const proxy = createServer();
  proxy.on("connect", (req, socket) => {
    auth = String(req.headers["proxy-authorization"] ?? "");
    const up = connect(tPort, "127.0.0.1", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      up.pipe(socket).pipe(up);
    });
  });
  const pPort = await listen(proxy);
  try {
    const f = proxiedFetch(`http://tester:pa55@127.0.0.1:${pPort}`);
    const r = await f(`http://127.0.0.1:${tPort}/x`);
    assert.deepEqual(await r.json(), { via: "target" });
    assert.equal(auth, `Basic ${Buffer.from("tester:pa55").toString("base64")}`);
  } finally {
    proxy.close();
    target.close();
  }
});

test("proxy errors are readable and never show the password", async () => {
  const proxy = createServer();
  proxy.on("connect", (_req, socket) => socket.end("HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"));
  const pPort = await listen(proxy);
  try {
    await assert.rejects(proxiedFetch(`http://u:wrong@127.0.0.1:${pPort}`)(`http://127.0.0.1:${pPort}/`), (e: Error) =>
      /логин или пароль/.test(e.message) && !e.message.includes("wrong"));
  } finally {
    proxy.close();
  }
  const closed = createServer();
  const port = await listen(closed);
  closed.close();
  await assert.rejects(proxiedFetch(`socks5://127.0.0.1:${port}`)("https://openrouter.ai/"), /не принимает подключения/);
});
