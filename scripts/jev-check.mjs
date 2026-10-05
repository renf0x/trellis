// Jev / OpenRouter connection check: why does Cloudflare answer 403 «Attention Required»?
// Usage: node scripts/jev-check.mjs   (key from OPENROUTER_API_KEY or data/secrets/openrouter.json; never printed)
// Spends a few tiny Jev calls (fractions of a cent). Writes nothing to Qase, Jira or Confluence.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const dataDir = resolve(process.env.TRELLIS_DATA ?? join(root, "data"));
let key = process.env.OPENROUTER_API_KEY ?? "";
try {
  key ||= JSON.parse(readFileSync(join(dataDir, "secrets", "openrouter.json"), "utf8")).apiKey ?? "";
} catch { /* no key file */ }

const URL_DECISIONS = "https://openrouter.ai/api/alpha/decisions";
const MODEL = (() => {
  try {
    return JSON.parse(readFileSync(join(dataDir, "config", "analysis.json"), "utf8")).jev?.model || "~typesafe/jev-latest";
  } catch {
    return "~typesafe/jev-latest";
  }
})();
// The same question shape as the coverage stage (modules/compare/server/stages.ts, coverageQuestions).
const QUESTIONS = {
  coverage: {
    type: "choice",
    instructions: "Decide whether the test case checks the requirement taken from the documentation.",
    criteria: {
      covered: "The test case checks the requirement fully, including its values, conditions and expected result",
      partial: "The test case touches the requirement but misses a condition, a value or the expected result",
      not_covered: "The test case does not check this requirement",
    },
  },
};
const HEADERS = { "Content-Type": "application/json", "HTTP-Referer": "http://127.0.0.1:5173", "X-Title": "Trellis", "User-Agent": "Trellis/0.1" };
const STATES = {
  tiny: "проверка связи",
  plain: { requirement: "Отображать название и цену товара на карточке", case: "Открыть карточку товара, проверить название и цену" },
  url: { requirement: "Вызывать метод GET /v1/catalog/product-card/mini?path={path}&id={id}&article={article} согласно контракту FE → BFF", case: "Шаг 1: открыть мини-КТ" },
  url_soft: { requirement: "Вызывать метод GET /v1/catalog/product-card/mini?path=⦃path⦄＆id=⦃id⦄＆article=⦃article⦄ согласно контракту FE → BFF", case: "Шаг 1: открыть мини-КТ" },
  json: { requirement: "rating — необязательный объект, может передаваться как null", case: "Ответ: {\"rating\": null, \"ratingAvg\": 4.5, \"reviewQty\": 3}" },
  header: { requirement: "Передавать заголовок Hoff-Business-Unit-Id вместо Authorization.", case: "Шаг 1: проверить заголовки запроса" },
};

function describe(status, headers, text) {
  const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
  let detail = title ? `HTML «${title}»` : text.slice(0, 160).replace(/\s+/g, " ");
  if (!title) {
    try {
      const j = JSON.parse(text);
      detail = j.error ? `error: ${j.error.message ?? JSON.stringify(j.error)}` : j.answers ? "ok, answers received" : detail;
    } catch { /* not JSON */ }
  }
  const cf = [headers.get?.("cf-mitigated") && `cf-mitigated=${headers.get("cf-mitigated")}`, headers.get?.("cf-ray") && `ray=${headers.get("cf-ray")}`]
    .filter(Boolean).join(" ");
  return `${status} ${cf} ${detail}`.replace(/\s+/g, " ").trim();
}

async function viaNode(state) {
  try {
    const res = await fetch(URL_DECISIONS, {
      method: "POST",
      headers: { ...HEADERS, Authorization: `Bearer ${key}` },
      body: JSON.stringify({ model: MODEL, state, questions: QUESTIONS }),
    });
    return describe(res.status, res.headers, await res.text());
  } catch (e) {
    return `network error: ${e.cause?.code ?? ""} ${e.message}`;
  }
}

/** The same request through curl.exe (another TLS fingerprint); the key goes in through stdin, not the command line. */
function curlRequest(state) {
  const body = JSON.stringify({ model: MODEL, state, questions: QUESTIONS }).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const config = [
    `url = "${URL_DECISIONS}"`,
    `request = "POST"`,
    `header = "Authorization: Bearer ${key}"`,
    ...Object.entries(HEADERS).map(([k, v]) => `header = "${k}: ${v}"`),
    `data-binary = "${body}"`,
    `silent`,
    `include`,
    `write-out = "\\n%{http_code}"`,
  ].join("\n");
  const r = spawnSync(process.platform === "win32" ? "curl.exe" : "curl", ["-K", "-"], { input: `${config}\n`, encoding: "utf8", timeout: 60000 });
  if (r.error) return `curl unavailable: ${r.error.message}`;
  const out = r.stdout ?? "";
  const status = Number(out.trim().split("\n").at(-1));
  const [head, ...rest] = out.split(/\r?\n\r?\n/);
  const headers = new Map(head.split(/\r?\n/).slice(1).map((l) => [l.split(":")[0].toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
  return describe(status, { get: (k) => headers.get(k) }, rest.join("\n\n").replace(/\n\d+\s*$/, ""));
}

const line = (name, result) => console.log(`${name.padEnd(22)} ${result}`);

console.log("Trellis Jev check");
line("node", process.version);
line("jev model", MODEL);
line("key", key ? `found (${key.length} chars)` : "NOT FOUND");
line("proxy env", ["HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"]
  .filter((n) => process.env[n] || process.env[n.toLowerCase()]).join(", ") || "none");

try {
  const res = await fetch("https://openrouter.ai/api/v1/models", { headers: { "User-Agent": HEADERS["User-Agent"] } });
  const text = await res.text();
  line("models (no key)", describe(res.status, res.headers, text.trimStart().startsWith("{") ? "" : text));
} catch (e) {
  line("models (no key)", `network error: ${e.cause?.code ?? ""} ${e.message}`);
}
if (key) {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${key}`, "User-Agent": HEADERS["User-Agent"] } });
    const text = await res.text();
    let info = "";
    try {
      const d = JSON.parse(text).data ?? {};
      info = `usage=${d.usage ?? "?"} limit=${d.limit ?? "none"} limit_remaining=${d.limit_remaining ?? "?"} free_tier=${d.is_free_tier ?? "?"}`;
    } catch { /* HTML or text */ }
    line("key check", `${describe(res.status, res.headers, info ? "" : text)} ${info}`.trim());
  } catch (e) {
    line("key check", `network error: ${e.message}`);
  }

  console.log("\nJev decisions, one request each (node fetch | curl):");
  for (const [name, state] of Object.entries(STATES)) {
    line(`  ${name} node`, await viaNode(state));
    line(`  ${name} curl`, curlRequest(state));
  }

  console.log("\nBurst: 6 tiny requests at once (node):");
  const burst = await Promise.all(Array.from({ length: 6 }, () => viaNode(STATES.tiny)));
  burst.forEach((r, i) => line(`  #${i + 1}`, r));
}

console.log(`
How to read:
- tiny node 403 HTML, tiny curl 200  -> Cloudflare blocks the Node client (TLS fingerprint), not the network.
- tiny node and curl both 403 HTML   -> the network address (corporate proxy, VPN) is blocked.
- tiny 200, url/json/header 403 HTML -> a content filter: some texts look like attacks; url_soft shows if look-alike characters pass.
- burst 403 only                     -> too many requests at once.
- 401 / 402                          -> key or balance, not Cloudflare.`);
