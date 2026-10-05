// Test runs in a real browser for the workbench chat: the model writes ```trellis-browser {json}``` blocks, this
// module drives Edge, Chrome or another Chromium through playwright-core and answers with a compact page snapshot (numbered elements
// and text). Expected results are checked by Jev (`verify`), so the chat model does not have to read whole pages.
// The window is visible and the profile persists in data/modules/test-runner/profile, so a tester can log in by hand.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright-core";
import { HttpError, type ChatToolResult, type ServerModuleContext } from "@trellis/core";
import { formatSnapshot, pageVerdict, type Snapshot } from "./snapshot.ts";

const STEP_TIMEOUT = 10_000;
const KEEP_SHOTS = 60;

// Runs in the page. A string, not a function: tsx would add helpers the page does not have.
const SNAPSHOT = `(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  document.querySelectorAll("[data-trellis-ref]").forEach((e) => e.removeAttribute("data-trellis-ref"));
  const sel = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],' +
    '[role=radio],[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[contenteditable=""],[contenteditable=true]';
  const clean = (s) => String(s || "").replace(/\\s+/g, " ").trim();
  const elements = [];
  let n = 0;
  for (const el of document.querySelectorAll(sel)) {
    if (n >= 150 || !visible(el)) continue;
    el.setAttribute("data-trellis-ref", String(++n));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type") || "";
    const label = clean(el.getAttribute("aria-label") || (el.labels && el.labels[0] && el.labels[0].innerText) ||
      el.getAttribute("placeholder") || el.getAttribute("title") || el.innerText || el.getAttribute("name")).slice(0, 80);
    let value = "";
    if (tag === "input" || tag === "textarea" || tag === "select") {
      value = type === "password" ? (el.value ? "***" : "") : clean(el.value).slice(0, 60);
    }
    const state = [el.disabled && "disabled", el.checked && "checked", el.getAttribute("aria-expanded") === "true" && "expanded",
      el.getAttribute("aria-invalid") === "true" && "invalid"].filter(Boolean).join(", ");
    elements.push({ ref: n, tag, type, role: el.getAttribute("role") || "", label, value, state });
  }
  const text = (document.body ? document.body.innerText : "").replace(/\\n{3,}/g, "\\n\\n").trim();
  return { url: location.href, title: document.title, elements, text };
})()`;

/**
 * Browsers to try, in order: TRELLIS_BROWSER (a path to any Chromium-based browser), Edge, Chrome, the Chromium
 * that `npx playwright install chromium` downloads, then Yandex Browser.
 */
function browsers(): { name: string; opts: { channel?: string; executablePath?: string } }[] {
  const file = (name: string, executablePath: string) => (executablePath && existsSync(executablePath) ? [{ name, opts: { executablePath } }] : []);
  const yandex = ["Yandex", "YandexBrowser", "Application", "browser.exe"];
  return [
    ...file("TRELLIS_BROWSER", process.env.TRELLIS_BROWSER ?? ""),
    { name: "Edge", opts: { channel: "msedge" } },
    { name: "Chrome", opts: { channel: "chrome" } },
    ...file("Chromium Playwright", chromium.executablePath()),
    ...file("Яндекс Браузер", join(process.env.ProgramFiles ?? "C:\\Program Files", ...yandex)),
    ...file("Яндекс Браузер", join(process.env.LOCALAPPDATA ?? "", ...yandex)),
  ];
}

interface Session {
  page: Page;
  dialogs: string[];
  errors: string[];
  acceptNextDialog: boolean;
}

export async function register(ctx: ServerModuleContext) {
  const profile = join(ctx.files.dir, "profile");
  const shots = join(ctx.files.dir, "shots");
  let browser: Promise<{ context: BrowserContext; channel: string }> | null = null;
  const sessions = new Map<string, Session>();

  function launch() {
    browser ??= (async () => {
      await mkdir(profile, { recursive: true });
      const opts = { headless: false, viewport: null, acceptDownloads: false, args: ["--no-first-run", "--no-default-browser-check"] };
      const failed: string[] = [];
      for (const b of browsers()) {
        try {
          const context = await chromium.launchPersistentContext(profile, { ...opts, ...b.opts });
          context.on("close", () => {
            browser = null;
            sessions.clear();
          });
          return { context, channel: b.name };
        } catch (err) {
          failed.push(`${b.name}: ${(err as Error).message.split("\n")[0].replace(/^browserType\.\w+: /, "")}`);
        }
      }
      browser = null;
      throw new Error(`не удалось открыть браузер (Edge, Chrome, Chromium Playwright, Яндекс Браузер). ${failed.join("; ")}`);
    })();
    return browser;
  }

  async function session(id: string): Promise<Session> {
    const known = sessions.get(id);
    if (known && !known.page.isClosed()) return known;
    const { context } = await launch();
    // The first chat takes the blank tab the browser opens with.
    const blank = context.pages().find((p) => p.url() === "about:blank" && ![...sessions.values()].some((s) => s.page === p));
    const page = blank ?? (await context.newPage());
    const s: Session = { page, dialogs: [], errors: [], acceptNextDialog: false };
    page.setDefaultTimeout(STEP_TIMEOUT);
    page.on("dialog", (d) => {
      const accept = d.type() === "alert" || d.type() === "beforeunload" || s.acceptNextDialog;
      s.dialogs.push(`${d.type()} «${d.message().slice(0, 200)}» — ${accept ? "принято" : "отклонено"}`);
      s.acceptNextDialog = false;
      void (accept ? d.accept() : d.dismiss()).catch(() => {});
    });
    page.on("pageerror", (e) => s.errors.push(e.message.split("\n")[0].slice(0, 200)));
    sessions.set(id, s);
    return s;
  }

  async function snapshot(s: Session): Promise<Snapshot> {
    await s.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    const snap = (await s.page.evaluate(SNAPSHOT)) as Snapshot;
    snap.dialogs = s.dialogs.splice(0);
    snap.errors = s.errors.splice(0).slice(-5);
    return snap;
  }

  function target(page: Page, input: Record<string, unknown>): Locator {
    if (input.ref !== undefined) return page.locator(`[data-trellis-ref="${Number(input.ref)}"]`);
    if (typeof input.label === "string") return page.getByLabel(input.label).first();
    if (typeof input.placeholder === "string") return page.getByPlaceholder(input.placeholder).first();
    if (typeof input.text === "string") return page.getByText(input.text).first();
    if (typeof input.selector === "string") return page.locator(input.selector).first();
    throw new Error("укажите ref (из последнего снимка), text, label или selector");
  }

  const describeTarget = (input: Record<string, unknown>) =>
    input.ref !== undefined ? `[${input.ref}]` : JSON.stringify(input.label ?? input.placeholder ?? input.text ?? input.selector);

  /** Runs one page action and answers with a fresh snapshot. */
  async function act(s: Session, summary: string, fn: () => Promise<unknown>): Promise<ChatToolResult> {
    await fn();
    await s.page.waitForTimeout(400);
    const snap = await snapshot(s);
    return { ok: true, summary: `${summary} → ${snap.title || snap.url}`, detail: formatSnapshot(snap, 2500) };
  }

  async function screenshot(s: Session, full: boolean): Promise<ChatToolResult> {
    await mkdir(shots, { recursive: true });
    const id = randomUUID();
    await s.page.screenshot({ path: join(shots, `${id}.png`), fullPage: full });
    const files = (await readdir(shots)).filter((f) => f.endsWith(".png"));
    if (files.length > KEEP_SHOTS) {
      const dated = await Promise.all(files.map(async (f) => ({ f, at: (await stat(join(shots, f))).mtimeMs })));
      for (const x of dated.sort((a, b) => a.at - b.at).slice(0, files.length - KEEP_SHOTS)) await rm(join(shots, x.f), { force: true });
    }
    return { ok: true, summary: "Снимок экрана", image: `/api/m/test-runner/shots/${id}` };
  }

  async function verify(s: Session, expected: string, signal: AbortSignal): Promise<ChatToolResult> {
    const snap = await snapshot(s);
    const pageText = formatSnapshot(snap, 6000);
    const jev = await ctx.llm.analysis().then((a) => a.jev).catch(() => null);
    if (!jev?.enabled) {
      return { ok: true, summary: "Jev выключен: сравните сами по тексту страницы", detail: pageText };
    }
    try {
      const v = await pageVerdict(ctx.llm, expected, snap, signal);
      const label = { matches: "соответствует", partial: "частично", mismatch: "не соответствует", cannot_tell: "не определить по странице" }[v.choice];
      const sure = v.confidence >= jev.threshold && v.choice !== "cannot_tell";
      return {
        ok: true,
        summary: `Jev: ${label} (${Math.round(v.confidence * 100)}%)`,
        // Unsure: the chat model judges by the page itself.
        detail: sure ? `URL: ${snap.url}` : `Jev не уверен, проверьте сами.\n${pageText}`,
      };
    } catch (err) {
      return { ok: true, summary: `Jev недоступен (${(err as Error).message.slice(0, 120)}): сравните сами`, detail: pageText };
    }
  }

  async function run(input: Record<string, unknown>, sessionId: string, signal: AbortSignal): Promise<ChatToolResult> {
    const action = String(input.action ?? "");
    if (action === "close") {
      const s = sessions.get(sessionId);
      sessions.delete(sessionId);
      await s?.page.close().catch(() => {});
      return { ok: true, summary: "Вкладка закрыта" };
    }
    const s = await session(sessionId);
    const page = s.page;
    switch (action) {
      case "open": {
        const url = String(input.url ?? "");
        if (!/^https?:\/\//i.test(url)) return { ok: false, summary: "Нужен адрес http(s)://" };
        return act(s, `Открыта ${url}`, () => page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }));
      }
      case "snapshot": {
        const snap = await snapshot(s);
        return { ok: true, summary: `Снимок: ${snap.title || snap.url}, элементов ${snap.elements.length}`, detail: formatSnapshot(snap, 2500) };
      }
      case "click":
        return act(s, `Нажато ${describeTarget(input)}`, () => target(page, input).click());
      case "fill": {
        const loc = target(page, input);
        const secret = (await loc.getAttribute("type").catch(() => null)) === "password";
        return act(s, `Заполнено ${describeTarget(input)}${secret ? "" : ` = «${String(input.value ?? "").slice(0, 60)}»`}`,
          () => loc.fill(String(input.value ?? "")));
      }
      case "press": {
        const key = String(input.key ?? "Enter");
        return act(s, `Клавиша ${key}`, () => (input.ref !== undefined || input.text || input.label ? target(page, input).press(key) : page.keyboard.press(key)));
      }
      case "select":
        return act(s, `Выбрано ${describeTarget(input)} = «${String(input.value ?? "")}»`,
          () => target(page, input).selectOption({ label: String(input.value ?? "") }).catch(() => target(page, input).selectOption(String(input.value ?? ""))));
      case "check":
        return act(s, `${input.checked === false ? "Снята" : "Поставлена"} отметка ${describeTarget(input)}`,
          () => target(page, input).setChecked(input.checked !== false));
      case "hover":
        return act(s, `Наведено на ${describeTarget(input)}`, () => target(page, input).hover());
      case "wait":
        if (typeof input.text === "string") {
          return act(s, `Дождались «${input.text}»`, () => page.getByText(input.text as string).first().waitFor({ timeout: Math.min(Number(input.ms) || 15_000, 60_000) }));
        }
        return act(s, `Пауза ${Math.min(Number(input.ms) || 1000, 30_000)} мс`, () => page.waitForTimeout(Math.min(Number(input.ms) || 1000, 30_000)));
      case "back":
        return act(s, "Назад", () => page.goBack({ waitUntil: "domcontentloaded" }));
      case "dialog":
        s.acceptNextDialog = input.accept === true;
        return { ok: true, summary: `Следующий диалог будет ${s.acceptNextDialog ? "принят" : "отклонён"}` };
      case "screenshot":
        return screenshot(s, input.full === true);
      case "verify": {
        const expected = String(input.expected ?? "").trim();
        if (!expected) return { ok: false, summary: "Укажите expected — ожидаемый результат шага" };
        return verify(s, expected.slice(0, 2000), signal);
      }
      default:
        return { ok: false, summary: `Неизвестное действие «${action}»` };
    }
  }

  ctx.chatTool({
    name: "browser",
    channels: ["work"],
    async run(input, { sessionId, signal }) {
      try {
        return await run(input, sessionId, signal);
      } catch (err) {
        const msg = (err as Error).message.split("\n")[0].replace(/\s+/g, " ").slice(0, 300);
        // A failed step still shows where the page is, so the model can report what is missing.
        const s = sessions.get(sessionId);
        const snap = s && !s.page.isClosed() ? await snapshot(s).catch(() => null) : null;
        return { ok: false, summary: `Не выполнено: ${msg}`, detail: snap ? formatSnapshot(snap, 2500) : undefined };
      }
    },
  });

  ctx.route("GET", "/shots/:id", async ({ params }) => {
    if (!/^[0-9a-f-]{36}$/.test(params.id)) throw new HttpError(400, "bad id");
    return readFile(join(shots, `${params.id}.png`)).catch(() => {
      throw new HttpError(404, "Снимок не найден");
    });
  });

  ctx.route("GET", "/status", async () => {
    const b = browser ? await browser.catch(() => null) : null;
    return { open: !!b, channel: b?.channel ?? null, tabs: [...sessions.values()].filter((s) => !s.page.isClosed()).length };
  });

  ctx.route("POST", "/close", async () => {
    const b = browser ? await browser.catch(() => null) : null;
    await b?.context.close().catch(() => {});
    browser = null;
    sessions.clear();
    return { ok: true };
  });
}
