// Test runs in a real browser for the workbench chat: the model writes ```trellis-browser {json}``` blocks, this
// module drives Edge, Chrome or another Chromium through playwright-core and answers with a compact page snapshot (numbered elements
// and text). Expected results are checked by Jev (`verify`), so the chat model does not have to read whole pages.
// The window is visible and the profile persists in data/modules/test-runner/profile, so a tester can log in by hand.
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Locator, type Page } from "playwright-core";
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
  // Adaptive layout: a page wider than the screen scrolls sideways; name the widest culprits.
  const vw = document.documentElement.clientWidth || innerWidth;
  const overflow = Math.max(0, document.documentElement.scrollWidth - vw);
  const wide = [];
  if (overflow > 0) {
    const out = [];
    for (const el of document.body ? document.body.querySelectorAll("*") : []) {
      const r = el.getBoundingClientRect();
      if (r.right > vw + 1 && r.width > 0 && visible(el)) out.push(el);
      if (out.length >= 300) break;
    }
    // The innermost ones: a wrapper sticks out because of what it holds.
    for (const el of out.filter((c) => !out.some((d) => d !== c && c.contains(d))).slice(0, 5)) {
      const id = el.id ? "#" + el.id : el.classList.length ? "." + [...el.classList].slice(0, 2).join(".") : "";
      wide.push(el.tagName.toLowerCase() + id + " (правый край " + Math.round(el.getBoundingClientRect().right) + " px)");
    }
  }
  return { url: location.href, title: document.title, elements, text, layout: { width: vw, overflow, wide } };
})()`;

const UA = `({ ua: navigator.userAgent, brands: navigator.userAgentData ? navigator.userAgentData.brands : [] })`;

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

/** Block pages of anti-bot filters and WAFs: the agent reports them instead of testing the error page. */
const BLOCK_PAGE = /\b403\b.*forbidden|access denied|доступ (к сайту .{0,40})?запрещ|attention required|проверка браузера/is;

/** A screen the case asks for: the page sees this size, and a mobile one also a phone's user agent and touch. */
interface Screen {
  width: number;
  height: number;
  mobile: boolean;
  label: string;
}

const PRESETS: Record<string, [number, number, boolean]> = {
  mobile: [360, 800, true], iphone: [390, 844, true], tablet: [768, 1024, true], laptop: [1366, 768, false], fullhd: [1920, 1080, false],
};

/** The screen an action asks for; null means the window's own size (desktop). */
export function screenFor(input: Record<string, unknown>): Screen | null {
  const preset = String(input.preset ?? "").toLowerCase();
  if (preset === "desktop" || preset === "reset") return null;
  const [pw, ph, pm] = PRESETS[preset] ?? [];
  const width = Math.round(Number(input.width ?? pw));
  if (!Number.isFinite(width) || width < 200 || width > 3840) throw new Error("ширина экрана — число от 200 до 3840 (или preset: mobile, tablet, desktop)");
  const mobile = typeof input.mobile === "boolean" ? input.mobile : pm ?? width <= 820;
  const height = Math.round(Number(input.height ?? ph ?? (width <= 480 ? 800 : Math.round(width * (mobile ? 4 / 3 : 0.6)))));
  if (!Number.isFinite(height) || height < 200 || height > 4000) throw new Error("высота экрана — число от 200 до 4000");
  return { width, height, mobile, label: `${width}×${height}${mobile ? ", мобильная версия" : ""}` };
}

/** A phone's user agent of the same browser version, with matching client hints (sites read both). */
export function mobileAgent(desktopUa: string, brands: { brand: string; version: string }[]) {
  const version = /Chrome\/(\d+)/.exec(desktopUa)?.[1] ?? "120";
  const edge = /Edg\/(\d+)/.exec(desktopUa)?.[1];
  return {
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version}.0.0.0 Mobile Safari/537.36${edge ? ` EdgA/${edge}.0.0.0` : ""}`,
    userAgentMetadata: { brands, platform: "Android", platformVersion: "10.0.0", architecture: "", model: "K", mobile: true },
  };
}

interface Session {
  page: Page;
  tabs: Set<Page>;
  screen: Screen | null;
  dialogs: string[];
  notes: string[];
  errors: string[];
  /** The page console and failed requests, as DevTools would show them; `logRead` is where `console` stopped. */
  log: string[];
  logRead: number;
  fresh: { errors: number; warnings: number; failed: number };
  acceptNextDialog: boolean;
}

const LOG_KEEP = 300;

export async function register(ctx: ServerModuleContext) {
  const profile = join(ctx.files.dir, "profile");
  const shots = join(ctx.files.dir, "shots");
  let browser: Promise<{ context: BrowserContext; channel: string }> | null = null;
  const sessions = new Map<string, Session>();

  function launch() {
    browser ??= (async () => {
      await mkdir(profile, { recursive: true });
      // Without the automation switch and with the usual sandbox the window is an ordinary browser to the site:
      // anti-bot filters (hoff.ru and the like) answer 403 to navigator.webdriver and --no-sandbox.
      const opts = {
        headless: false, viewport: null, acceptDownloads: false, chromiumSandbox: true,
        ignoreDefaultArgs: ["--enable-automation"],
        args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
      };
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

  // Screen emulation goes through our own CDP session per tab, as DevTools' device mode does: a persistent
  // context (kept for logins) cannot switch Playwright's isMobile on the fly.
  const cdps = new WeakMap<Page, CDPSession>();

  async function emulate(page: Page, screen: Screen | null) {
    // Detaching alone keeps the overrides: they are dropped one by one (an empty user agent means the real one).
    let cdp = cdps.get(page);
    if (cdp) {
      await cdp.send("Emulation.clearDeviceMetricsOverride").catch(() => {});
      await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => {});
      await cdp.send("Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => {});
    }
    if (!screen) return;
    if (!cdp) {
      cdp = await page.context().newCDPSession(page);
      cdps.set(page, cdp);
    }
    const { width, height, mobile } = screen;
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width, height, deviceScaleFactor: mobile ? 2 : 1, mobile, screenWidth: width, screenHeight: height,
    });
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: mobile, maxTouchPoints: mobile ? 5 : 0 });
    if (mobile) {
      const real = (await page.evaluate(UA)) as { ua: string; brands: { brand: string; version: string }[] };
      await cdp.send("Emulation.setUserAgentOverride", mobileAgent(real.ua, real.brands));
    }
  }

  /** Listeners of one tab; a tab the page opens (target=_blank, window.open) becomes the session's tab. */
  function attach(s: Session, page: Page) {
    s.tabs.add(page);
    page.setDefaultTimeout(STEP_TIMEOUT);
    page.on("dialog", (d) => {
      const accept = d.type() === "alert" || d.type() === "beforeunload" || s.acceptNextDialog;
      s.dialogs.push(`${d.type()} «${d.message().slice(0, 200)}» — ${accept ? "принято" : "отклонено"}`);
      s.acceptNextDialog = false;
      void (accept ? d.accept() : d.dismiss()).catch(() => {});
    });
    const log = (line: string) => {
      s.log.push(line.slice(0, 500));
      const extra = s.log.length - LOG_KEEP;
      if (extra > 0) {
        s.log.splice(0, extra);
        s.logRead = Math.max(0, s.logRead - extra);
      }
    };
    page.on("pageerror", (e) => {
      s.errors.push(e.message.split("\n")[0].slice(0, 200));
      s.fresh.errors++;
      log(`ошибка (исключение): ${e.message.split("\n")[0]}`);
    });
    page.on("console", (m) => {
      const type = m.type();
      if (type === "error") s.fresh.errors++;
      else if (type === "warning") s.fresh.warnings++;
      const where = m.location()?.url ? ` (${m.location().url.split("?")[0]}:${m.location().lineNumber})` : "";
      log(`${type}: ${m.text()}${type === "error" || type === "warning" ? where : ""}`);
    });
    page.on("requestfailed", (r) => {
      // Requests cut off by a navigation or reload are not the site's errors.
      if (r.failure()?.errorText.includes("ERR_ABORTED")) return;
      s.fresh.failed++;
      log(`запрос не выполнен: ${r.method()} ${r.url().split("?")[0]} — ${r.failure()?.errorText ?? "ошибка"}`);
    });
    page.on("response", (r) => {
      if (r.status() < 400) return;
      s.fresh.failed++;
      log(`запрос: ${r.status()} ${r.request().method()} ${r.url().split("?")[0]}`);
    });
    page.on("popup", (tab) => {
      attach(s, tab);
      s.page = tab;
      s.notes.push("открылась новая вкладка, дальше действия в ней");
      if (s.screen) {
        const screen = s.screen;
        void emulate(tab, screen).then(() => tab.reload({ waitUntil: "domcontentloaded" })).catch(() => {});
      }
    });
    page.on("close", () => {
      s.tabs.delete(page);
      const back = [...s.tabs].at(-1);
      if (s.page === page && back) {
        s.page = back;
        s.notes.push("вкладка закрылась, вернулись в предыдущую");
      }
    });
  }

  async function session(id: string): Promise<Session> {
    const known = sessions.get(id);
    if (known && !known.page.isClosed()) return known;
    const { context } = await launch();
    // The first chat takes the blank tab the browser opens with.
    const blank = context.pages().find((p) => p.url() === "about:blank" && ![...sessions.values()].some((s) => s.tabs.has(p)));
    const page = blank ?? (await context.newPage());
    const s: Session = {
      page, tabs: new Set(), screen: null, dialogs: [], notes: [], errors: [],
      log: [], logRead: 0, fresh: { errors: 0, warnings: 0, failed: 0 }, acceptNextDialog: false,
    };
    attach(s, page);
    sessions.set(id, s);
    return s;
  }

  async function snapshot(s: Session): Promise<Snapshot> {
    await s.page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => {});
    const snap = (await s.page.evaluate(SNAPSHOT)) as Snapshot;
    if (s.screen) snap.screen = s.screen.label;
    snap.dialogs = s.dialogs.splice(0);
    snap.notes = s.notes.splice(0);
    snap.errors = s.errors.splice(0).slice(-5);
    snap.console = s.fresh;
    s.fresh = { errors: 0, warnings: 0, failed: 0 };
    return snap;
  }

  /** What DevTools' console would show: new entries since the last look (or all kept), and an expression's value. */
  async function consoleOf(s: Session, input: Record<string, unknown>): Promise<ChatToolResult> {
    const level = String(input.level ?? "").toLowerCase();
    const from = input.all === true ? 0 : s.logRead;
    s.logRead = s.log.length;
    const pick = { error: /^(ошибка|error|запрос)/, warning: /^(warning|ошибка|error|запрос)/ }[level];
    const lines = s.log.slice(from).filter((l) => !pick || pick.test(l));
    const parts = [lines.length ? lines.join("\n") : "Новых записей в консоли нет."];
    let summary = `Консоль: записей ${lines.length}`;
    if (typeof input.run === "string" && input.run.trim()) {
      const value = await s.page.evaluate(`(async () => { const v = await (${input.run}); try { return JSON.stringify(v, null, 1) ?? String(v); } catch { return String(v); } })()`)
        .then((v) => String(v).slice(0, 4000), (err: Error) => `ошибка: ${err.message.split("\n")[0]}`);
      parts.push(`> ${input.run.slice(0, 300)}\n${value}`);
      summary += `; выполнено выражение`;
    }
    return { ok: true, summary, detail: parts.join("\n\n") };
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
    const blocked = BLOCK_PAGE.test(`${snap.title}\n${snap.text.slice(0, 600)}`)
      ? " (похоже на блокировку сайтом: пройдите проверку вручную в этом окне или попросите доступ для тестов)" : "";
    return { ok: true, summary: `${summary} → ${snap.title || snap.url}${blocked}`, detail: formatSnapshot(snap, 2500) };
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
      for (const tab of s?.tabs ?? []) await tab.close().catch(() => {});
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
      case "viewport": {
        const screen = screenFor(input);
        // Sites pick the mobile layout by the user agent on load, so an open page is loaded again.
        const reload = page.url() !== "about:blank";
        return act(s, `Экран ${screen ? screen.label : "компьютера (размер окна)"}${reload ? ", страница перезагружена" : ""}`, async () => {
          await emulate(page, screen);
          s.screen = screen;
          if (reload) await page.reload({ waitUntil: "domcontentloaded", timeout: 30_000 });
        });
      }
      case "console":
        return consoleOf(s, input);
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
