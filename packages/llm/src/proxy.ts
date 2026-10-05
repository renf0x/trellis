// A proxy for Jev only: OpenRouter's Decisions API may refuse some countries while the chat works directly.
// The proxy URL may carry a login and password, so it never leaves the server: the UI sees proxyHint() only.
import { fetch as undiciFetch, ProxyAgent, Socks5ProxyAgent, type Dispatcher } from "undici";
import { LlmError } from "./sse.ts";

const DEFAULT_PORT: Record<string, string> = { "http:": "80", "https:": "443", "socks5:": "1080" };

/** Parses http://, https:// or socks5:// (socks5h:// and socks:// are read as socks5://), with an optional user:pass@. */
export function parseProxyUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new LlmError(400, "Адрес прокси не разобран. Пример: socks5://user:pass@host:1080 или http://host:3128");
  }
  if (u.protocol === "socks5h:" || u.protocol === "socks:") u = new URL(`socks5:${raw.trim().slice(u.protocol.length)}`);
  if (!DEFAULT_PORT[u.protocol]) throw new LlmError(400, "Прокси поддерживается только http://, https:// или socks5://");
  if (!u.hostname) throw new LlmError(400, "В адресе прокси нет хоста");
  return u;
}

/** Scheme, host and port, without the login and password: safe to show and to log. */
export function proxyHint(raw: string): string {
  const u = parseProxyUrl(raw);
  return `${u.protocol}//${u.hostname}:${u.port || DEFAULT_PORT[u.protocol]}${u.username ? " (с логином)" : ""}`;
}

export function proxyAgent(raw: string): Dispatcher {
  const u = parseProxyUrl(raw);
  return u.protocol === "socks5:" ? new Socks5ProxyAgent(u.href) : new ProxyAgent({ uri: u.href });
}

function chain(err: unknown) {
  const parts: { code?: string; message: string }[] = [];
  for (let e = err as any, n = 0; e && n < 5; e = e.cause, n++) parts.push({ code: e.code, message: String(e.message ?? e) });
  return parts;
}

/** Connection errors in words a tester can act on; the original text stays at the end for support. */
export function proxyError(err: unknown, hint: string): LlmError {
  const parts = chain(err);
  const codes = new Set(parts.map((p) => p.code));
  const text = parts.map((p) => p.message).join(" ← ");
  const has = (re: RegExp) => re.test(text);
  let why: string;
  if (has(/\b407\b/) || has(/auth/i)) why = "прокси отклонил логин или пароль";
  else if (codes.has("ECONNREFUSED")) why = "прокси не принимает подключения: проверьте хост и порт";
  else if (codes.has("ENOTFOUND") || codes.has("EAI_AGAIN")) why = "хост прокси не найден";
  else if (codes.has("UND_ERR_CONNECT_TIMEOUT") || codes.has("ETIMEDOUT") || has(/timeout/i)) why = "прокси не отвечает";
  else if (codes.has("ECONNRESET") || has(/socket/i)) why = "прокси оборвал соединение";
  else why = "не удалось подключиться";
  return new LlmError(502, `Jev через прокси ${hint}: ${why}. (${text.slice(0, 300)})`);
}

let cached: { raw: string; agent: Dispatcher } | null = null;

/** A fetch for jevDecide that goes through the proxy; one agent is kept and replaced when the URL changes. */
export function proxiedFetch(raw: string): typeof fetch {
  if (cached?.raw !== raw) {
    void cached?.agent.close().catch(() => {});
    cached = { raw, agent: proxyAgent(raw) };
  }
  const { agent } = cached;
  const hint = proxyHint(raw);
  return (async (input: any, init?: any) => {
    try {
      return await undiciFetch(input, { ...init, dispatcher: agent });
    } catch (err) {
      if (init?.signal?.aborted) throw err;
      throw proxyError(err, hint);
    }
  }) as unknown as typeof fetch;
}
