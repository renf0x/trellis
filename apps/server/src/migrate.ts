// Data folder format version and migrations. Everything the tester owns lives in data/ (gitignored),
// so an app update never overwrites it; when the format changes, the server migrates it on start,
// after a full copy into data-backups/. A newer data folder is never opened by an older app.
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** Bump together with a new entry in MIGRATIONS. */
export const DATA_VERSION = 1;

export interface Migration {
  to: number;
  title: string;
  run(dataDir: string): Promise<void>;
}

/** Ordered by `to`. Version 1 is the layout of the first tester builds: nothing to change. */
export const MIGRATIONS: Migration[] = [
  { to: 1, title: "Базовый формат: trellis.db, config, modules, secrets, usage, chats", run: async () => {} },
];

interface VersionFile { version: number; updatedAt: string; history: { from: number; to: number; at: string; backup?: string }[] }

const versionFile = (dataDir: string) => join(dataDir, "VERSION.json");
export const backupsDir = (dataDir: string) => join(dirname(dataDir), `${basename(dataDir)}-backups`);
const KEEP_BACKUPS = 10;

async function exists(p: string) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

export async function readDataVersion(dataDir: string): Promise<VersionFile | null> {
  try {
    return JSON.parse(await readFile(versionFile(dataDir), "utf8")) as VersionFile;
  } catch {
    return null;
  }
}

/** Data written before versioning existed counts as version 1. */
async function currentVersion(dataDir: string): Promise<VersionFile> {
  const v = await readDataVersion(dataDir);
  if (v && Number.isInteger(v.version)) return { ...v, history: Array.isArray(v.history) ? v.history : [] };
  return { version: (await isEmpty(dataDir)) ? DATA_VERSION : 1, updatedAt: new Date().toISOString(), history: [] };
}

async function isEmpty(dataDir: string) {
  try {
    return (await readdir(dataDir)).filter((n) => n !== "VERSION.json").length === 0;
  } catch {
    return true;
  }
}

async function writeVersion(dataDir: string, v: VersionFile) {
  await mkdir(dataDir, { recursive: true });
  const file = versionFile(dataDir);
  await writeFile(`${file}.tmp`, JSON.stringify(v, null, 2), "utf8");
  await rename(`${file}.tmp`, file);
}

const stamp = () => new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

/** Full copy of the data folder. Run it while the server is stopped, or before it opens the database. */
export async function backupData(dataDir: string, reason: string): Promise<string | null> {
  if (await isEmpty(dataDir)) return null;
  const root = backupsDir(dataDir);
  const name = `${stamp()}-${reason.replace(/[^\w-]+/g, "-").slice(0, 40)}`;
  await mkdir(root, { recursive: true });
  await cp(dataDir, join(root, name), { recursive: true, filter: (src) => !src.endsWith(".tmp") });
  await pruneBackups(root);
  return join(root, name);
}

export async function listBackups(dataDir: string): Promise<string[]> {
  try {
    return (await readdir(backupsDir(dataDir), { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  } catch {
    return [];
  }
}

async function pruneBackups(root: string) {
  const names = (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  for (const n of names.slice(KEEP_BACKUPS)) await rm(join(root, n), { recursive: true, force: true });
}

/** Puts a backup back; the current data is backed up first, so a restore can be undone too. */
export async function restoreData(dataDir: string, name: string) {
  const src = join(backupsDir(dataDir), basename(name));
  if (!(await exists(src))) throw new Error(`Нет резервной копии ${name}`);
  await backupData(dataDir, "before-restore");
  await rm(dataDir, { recursive: true, force: true });
  await cp(src, dataDir, { recursive: true });
}

export class DataTooNewError extends Error {}

/** Brings data/ to DATA_VERSION. Returns what happened, for the log. */
export async function migrateData(dataDir: string, log: (msg: string) => void = () => {},
  opts: { migrations?: Migration[]; target?: number } = {}) {
  const target = opts.target ?? DATA_VERSION;
  const v = await currentVersion(dataDir);
  if (v.version > target) {
    throw new DataTooNewError(
      `Данные в ${dataDir} записаны более новой версией Trellis (формат ${v.version}, эта версия понимает ${target}). ` +
      "Обновите приложение (update.cmd) или восстановите копию из data-backups.");
  }
  const pending = (opts.migrations ?? MIGRATIONS).filter((m) => m.to > v.version && m.to <= target).sort((a, b) => a.to - b.to);
  if (!pending.length) {
    if (!(await readDataVersion(dataDir))) await writeVersion(dataDir, { ...v, updatedAt: new Date().toISOString() });
    return { from: v.version, to: v.version, backup: null as string | null, applied: [] as string[] };
  }
  const backup = await backupData(dataDir, `before-format-${pending[pending.length - 1].to}`);
  if (backup) log(`Резервная копия данных: ${backup}`);
  const from = v.version;
  for (const m of pending) {
    const step = v.version;
    log(`Миграция данных ${step} → ${m.to}: ${m.title}`);
    await m.run(dataDir);
    v.version = m.to;
    v.history.push({ from: step, to: m.to, at: new Date().toISOString(), ...(backup ? { backup } : {}) });
    await writeVersion(dataDir, { ...v, updatedAt: new Date().toISOString() });
  }
  return { from, to: v.version, backup, applied: pending.map((m) => m.title) };
}
