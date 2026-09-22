import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyHttp, normalizeBaseUrl, parseSteps, testConnection } from "./azure.ts";

test("normalizeBaseUrl accepts org names and full URLs", () => {
  assert.equal(normalizeBaseUrl("my-org"), "https://dev.azure.com/my-org");
  assert.equal(normalizeBaseUrl("https://dev.azure.com/my-org/My%20Project/_wiki"), "https://dev.azure.com/my-org");
  assert.equal(normalizeBaseUrl("https://my-org.visualstudio.com/Proj"), "https://my-org.visualstudio.com");
  assert.equal(normalizeBaseUrl("https://tfs.corp/tfs/DefaultCollection/"), "https://tfs.corp/tfs/DefaultCollection");
  assert.throws(() => normalizeBaseUrl("tfs.corp/tfs"));
});

test("parseSteps reads action, expected and shared steps", () => {
  const xml =
    '<steps id="0" last="4"><step id="2" type="ActionStep">' +
    '<parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;Открыть &amp;quot;Вход&amp;quot;&lt;/P&gt;&lt;/DIV&gt;</parameterizedString>' +
    '<parameterizedString isformatted="true">&lt;P&gt;Форма видна&lt;BR/&gt;Кнопка активна&lt;/P&gt;</parameterizedString>' +
    '<description/></step><compref id="3" ref="1234"></compref>' +
    '<step id="4" type="ValidateStep"><parameterizedString isformatted="true">Ввести пароль</parameterizedString>' +
    '<parameterizedString isformatted="true"/></step></steps>';
  assert.deepEqual(parseSteps(xml), [
    { kind: "step", action: 'Открыть "Вход"', expected: "Форма видна\nКнопка активна" },
    { kind: "shared", action: "Общие шаги #1234", expected: "", sharedId: 1234 },
    { kind: "step", action: "Ввести пароль", expected: "" },
  ]);
  assert.deepEqual(parseSteps(undefined), []);
});

test("classifyHttp explains the usual failures", () => {
  assert.equal(classifyHttp(203, "text/html", "<html>").kind, "signin");
  assert.equal(classifyHttp(401, "", "").kind, "auth");
  assert.equal(classifyHttp(403, "application/json", '{"message":"TF400813"}').message, "Недостаточно прав (403). TF400813");
  assert.equal(
    classifyHttp(400, "application/json", '{"message":"The requested REST API version of 7.1 is out of range for this server."}').kind,
    "version");
});

/** Fake Azure DevOps Server 2020: API 6.0 max, wiki readable, no Test Management scope. */
const fakeServer: typeof fetch = async (input) => {
  const url = new URL(String(input));
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const v = url.searchParams.get("api-version");
  if (url.pathname.endsWith("/_apis/connectionData")) return json(200, { authenticatedUser: { providerDisplayName: "Tester" } });
  if (v && Number(v) > 6) return json(400, { message: `The requested REST API version of ${v} is out of range for this server.` });
  if (url.pathname.includes("/_apis/projects/")) return json(200, { name: "Proj" });
  if (url.pathname.endsWith("/_apis/wiki/wikis")) return json(200, { value: [{ name: "Proj.wiki" }] });
  if (url.pathname.endsWith("/_apis/testplan/plans")) return json(403, { message: "TF401027: You need Test Management." });
  return json(200, { value: [] });
};

test("testConnection negotiates the API version and reports missing scopes", async () => {
  const r = await testConnection({ baseUrl: "https://tfs.corp/tfs/DefaultCollection", project: "Proj" }, "pat", fakeServer);
  assert.equal(r.apiVersion, "6.0");
  assert.equal(r.user, "Tester");
  assert.equal(r.ok, false);
  const byId = Object.fromEntries(r.steps.map((s) => [s.id, s]));
  assert.equal(byId.wiki.ok, true);
  assert.equal(byId.testplans.ok, false);
  assert.match(byId.testplans.detail, /Test Management \(Read\)/);
  assert.equal(byId.workitems.ok, true);
});

test("testConnection stops early when the server is unreachable", async () => {
  const down: typeof fetch = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } });
  };
  const r = await testConnection({ baseUrl: "https://nope.example/tfs", project: "P" }, undefined, down);
  assert.equal(r.ok, false);
  assert.equal(r.steps.length, 1);
  assert.match(r.steps[0].detail, /DNS/);
});
