// Module manifest contract (modules/<id>/module.json). Browser-safe: no Node imports.
import { CHAT_CHANNELS, type ChatChannel } from "./llm.ts";

export const SLOTS = ["sidebar", "center-tab", "right-panel", "dashboard-widget", "settings-page"] as const;
export type SlotName = (typeof SLOTS)[number];

/** Sidebar groups; a module picks one via `section`. Order here is display order. */
export const SECTIONS = {
  work: "Основная работа",
  dev: "Развитие приложения",
  analytics: "Аналитика",
  memory: "Память (Arbor)",
} as const;
export type SectionId = keyof typeof SECTIONS;

export const PERMISSIONS = [
  "arbor:read",
  "arbor:write",
  "sources:read",
  "sources:write", // only through confirmed proposals
  "data:write", // replace imported docs and cases in the local store (connectors)
  "llm:main",
  "llm:dev",
  "playwright",
  "settings:write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export interface SlotDecl {
  slot: SlotName;
  /** Sidebar group (sidebar) or the sections a panel is shown for (right-panel). */
  section?: SectionId | SectionId[];
  label?: string;
  order?: number;
}

/** A button under chat messages: posts `{title, summary}` (from the message) to the module's own route. */
export interface ChatActionDecl {
  id: string;
  label: string;
  /** lucide-react icon name. */
  icon?: string;
  /** "/api/m/<this module id>/…" */
  post: string;
}

/** What a module adds to a chat: extra system prompt text and message actions. */
export interface ChatContribution {
  channel: ChatChannel;
  prompt?: string;
  actions?: ChatActionDecl[];
}

export interface ModuleManifest {
  id: string;
  title: string;
  version: string;
  description?: string;
  /** lucide-react icon name, e.g. "FileText". */
  icon?: string;
  /** Planned stage while the module is a placeholder. */
  stage?: number;
  slots: SlotDecl[];
  permissions: Permission[];
  /** Relative path to a server entry exporting `register(ctx)`. */
  server?: string;
  /** Relative path to a React entry with a default export component. */
  ui?: string;
  chat?: ChatContribution[];
}

export interface ManifestIssue {
  path: string;
  message: string;
}

const ID_RE = /^[a-z][a-z0-9-]{1,48}$/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Validates untrusted JSON; returns the manifest or the list of problems. */
export function validateManifest(raw: unknown):
  | { ok: true; manifest: ModuleManifest }
  | { ok: false; issues: ManifestIssue[] } {
  const issues: ManifestIssue[] = [];
  const bad = (path: string, message: string) => issues.push({ path, message });
  if (!isRecord(raw)) return { ok: false, issues: [{ path: "", message: "manifest must be an object" }] };

  if (typeof raw.id !== "string" || !ID_RE.test(raw.id)) bad("id", "kebab-case id, 2-49 chars");
  if (typeof raw.title !== "string" || !raw.title.trim()) bad("title", "required string");
  if (typeof raw.version !== "string") bad("version", "required string");
  for (const key of ["description", "icon", "server", "ui"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") bad(key, "must be a string");
  }
  for (const key of ["server", "ui"] as const) {
    const p = raw[key];
    if (typeof p === "string" && (p.includes("..") || /^([a-zA-Z]:|[\\/])/.test(p))) {
      bad(key, "must be a relative path inside the module folder");
    }
  }
  if (raw.stage !== undefined && typeof raw.stage !== "number") bad("stage", "must be a number");

  if (!Array.isArray(raw.slots)) bad("slots", "required array");
  else raw.slots.forEach((s, i) => {
    if (!isRecord(s)) return bad(`slots[${i}]`, "must be an object");
    if (!SLOTS.includes(s.slot as SlotName)) bad(`slots[${i}].slot`, `one of ${SLOTS.join(", ")}`);
    const sections = s.section === undefined ? [] : Array.isArray(s.section) ? s.section : [s.section];
    for (const sec of sections) {
      if (!(typeof sec === "string" && sec in SECTIONS)) bad(`slots[${i}].section`, `unknown section ${String(sec)}`);
    }
    if (s.order !== undefined && typeof s.order !== "number") bad(`slots[${i}].order`, "must be a number");
  });

  if (!Array.isArray(raw.permissions)) bad("permissions", "required array");
  else raw.permissions.forEach((p, i) => {
    if (!PERMISSIONS.includes(p as Permission)) bad(`permissions[${i}]`, `unknown permission ${String(p)}`);
  });

  if (raw.chat !== undefined) {
    if (!Array.isArray(raw.chat)) bad("chat", "must be an array");
    else raw.chat.forEach((c, i) => {
      const at = `chat[${i}]`;
      if (!isRecord(c)) return bad(at, "must be an object");
      if (!CHAT_CHANNELS.includes(c.channel as ChatChannel)) bad(`${at}.channel`, `one of ${CHAT_CHANNELS.join(", ")}`);
      if (c.prompt !== undefined && (typeof c.prompt !== "string" || c.prompt.length > 2000)) bad(`${at}.prompt`, "string up to 2000 chars");
      if (c.actions === undefined) return;
      if (!Array.isArray(c.actions)) return bad(`${at}.actions`, "must be an array");
      c.actions.forEach((a, j) => {
        const ap = `${at}.actions[${j}]`;
        if (!isRecord(a)) return bad(ap, "must be an object");
        if (typeof a.id !== "string" || !/^[a-z][a-z0-9-]{0,40}$/.test(a.id)) bad(`${ap}.id`, "kebab-case id");
        if (typeof a.label !== "string" || !a.label.trim()) bad(`${ap}.label`, "required string");
        if (a.icon !== undefined && typeof a.icon !== "string") bad(`${ap}.icon`, "must be a string");
        const own = `/api/m/${String(raw.id)}/`;
        if (typeof a.post !== "string" || !a.post.startsWith(own) || a.post.includes("..")) bad(`${ap}.post`, `must start with ${own}`);
      });
    });
  }

  return issues.length ? { ok: false, issues } : { ok: true, manifest: raw as unknown as ModuleManifest };
}

export function sectionsOf(slot: SlotDecl): SectionId[] {
  if (slot.section === undefined) return [];
  return Array.isArray(slot.section) ? slot.section : [slot.section];
}
