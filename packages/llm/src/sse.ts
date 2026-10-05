// Minimal Server-Sent Events reader for streaming LLM responses.

export interface SseEvent {
  event?: string;
  data: string;
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buf = "";
  let event: string | undefined;
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      buf += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") {
          if (data.length) yield { event, data: data.join("\n") };
          event = undefined;
          data = [];
          continue;
        }
        if (line.startsWith(":")) continue; // comment / keep-alive
        const i = line.indexOf(":");
        const field = i < 0 ? line : line.slice(0, i);
        let v = i < 0 ? "" : line.slice(i + 1);
        if (v.startsWith(" ")) v = v.slice(1);
        if (field === "event") event = v;
        else if (field === "data") data.push(v);
      }
      if (done) {
        if (buf.trim()) data.push(buf.replace(/^data: ?/, ""));
        if (data.length) yield { event, data: data.join("\n") };
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

/** Provider error with an HTTP-like status; the message is safe to show to the user. */
export class LlmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = "LlmError";
  }
}

/** Rate limits, overload and gateway errors pass with time: retry them before any output. */
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504, 520, 522, 524]);
/** Cloudflare in front of OpenRouter answers bursts with an HTML challenge page (usually 403) instead of JSON. */
const isHtml = (text: string) => /^\s*<(!doctype|html)/i.test(text);

export const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(t), reject(signal.reason)), { once: true });
  });

/**
 * Sends, and on a passing failure (status above, a Cloudflare page, a dropped connection) waits and sends again,
 * once per delay; the pauses are jittered so parallel workers don't come back together. Returns the last response.
 */
export async function sendWithRetry(send: () => Promise<Response>, delays: number[], signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= delays.length;
    let res: Response;
    try {
      res = await send();
    } catch (e) {
      if (signal?.aborted || last) throw e;
      await sleep(delays[attempt] * (0.75 + Math.random() * 0.5), signal);
      continue;
    }
    if (res.ok || last) return res;
    let retry = RETRY_STATUS.has(res.status);
    if (!retry && res.status === 403) retry = isHtml(await res.clone().text().catch(() => ""));
    if (!retry) return res;
    await res.body?.cancel();
    await sleep(delays[attempt] * (0.75 + Math.random() * 0.5), signal);
  }
}

export async function errorFrom(res: Response, provider: string): Promise<LlmError> {
  const text = await res.text().catch(() => "");
  if (isHtml(text)) {
    const title = /<title>([^<]*)<\/title>/i.exec(text)?.[1]?.trim();
    return new LlmError(res.status, `${provider}: ${res.status}, вместо ответа пришла страница Cloudflare${title ? ` («${title}»)` : ""}. ` +
      "Защита OpenRouter не пропустила запрос, обычно из-за слишком частых запросов. Повторы не помогли: " +
      "запустите ещё раз через минуту.");
  }
  let message = text;
  try {
    const j = JSON.parse(text);
    message = j.error?.message ?? j.detail?.message ?? j.detail ?? j.message ?? text;
  } catch {
    /* plain text body */
  }
  return new LlmError(res.status, `${provider}: ${res.status} ${String(message).slice(0, 500) || res.statusText}`);
}
