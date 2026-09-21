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

export async function errorFrom(res: Response, provider: string): Promise<LlmError> {
  const text = await res.text().catch(() => "");
  let message = text;
  try {
    const j = JSON.parse(text);
    message = j.error?.message ?? j.detail?.message ?? j.detail ?? j.message ?? text;
  } catch {
    /* plain text body */
  }
  return new LlmError(res.status, `${provider}: ${res.status} ${String(message).slice(0, 500) || res.statusText}`);
}
