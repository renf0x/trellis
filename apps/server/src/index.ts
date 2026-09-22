// Trellis local server: module registry, Arbor runtime vault, module routes.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import { ArborBridge, ArborError } from "@trellis/arbor-bridge";
import {
  HttpError,
  PermissionError,
  loadModules,
  scopedData,
  scopedLlm,
  scopedMemory,
  type MemoryStore,
  type RegistrySnapshot,
  type ServerModuleContext,
} from "@trellis/core/node";
import { LlmError } from "@trellis/llm";
import { registerLlm } from "./llm.ts";
import { SqliteDataStore } from "./store.ts";

const repoRoot = resolve(fileURLToPath(import.meta.url), "../../../..");
const dataDir = resolve(process.env.TRELLIS_DATA ?? join(repoRoot, "data"));
const modulesDir = join(repoRoot, "modules");
const port = Number(process.env.TRELLIS_PORT ?? 4317);

async function readDisabled(): Promise<string[]> {
  try {
    const cfg = JSON.parse(await readFile(join(dataDir, "config", "modules.json"), "utf8"));
    return Array.isArray(cfg.disabled) ? cfg.disabled : [];
  } catch {
    return [];
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
}
async function writeJson(file: string, value: unknown) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2), { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
}

async function main() {
  await mkdir(join(dataDir, "config"), { recursive: true });
  const arbor = new ArborBridge({ root: join(dataDir, "vault"), script: join(repoRoot, "arbor.py") });
  if (!arbor.initialized) await arbor.init();

  const dataStore = new SqliteDataStore(join(dataDir, "trellis.db"), join(dataDir, "obsidian"));
  const app = Fastify({ logger: { level: process.env.TRELLIS_LOG ?? "info" } });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message });
    if (err instanceof PermissionError) return reply.status(403).send({ error: err.message });
    if (err instanceof LlmError) return reply.status(502).send({ error: err.message });
    if (err instanceof ArborError) return reply.status(502).send({ error: `Arbor: ${err.message}` });
    if (err.statusCode && err.statusCode < 500) return reply.status(err.statusCode).send({ error: err.message });
    app.log.error(err);
    return reply.status(500).send({ error: "internal error" });
  });

  const llm = await registerLlm(app, dataDir);

  // Server entries are loaded once at start; manifests are re-read on each /api/modules call.
  const startup = await loadModules(modulesDir, { disabled: await readDisabled() });
  const serverLoaded = new Set<string>();
  const serverErrors: RegistrySnapshot["errors"] = [];

  for (const mod of startup.modules) {
    const { manifest } = mod;
    const serverEntry = manifest.server;
    if (!mod.enabled || !serverEntry) continue;
    const filesDir = join(dataDir, "modules", manifest.id);
    const secretFile = join(dataDir, "secrets", "modules", `${manifest.id}.json`);
    const safeName = (name: string) => {
      if (!/^[a-z0-9][a-z0-9._-]{0,60}$/i.test(name) || name.includes("..")) throw new Error(`bad file name ${name}`);
      return join(filesDir, name.endsWith(".json") ? name : `${name}.json`);
    };
    const ctx: ServerModuleContext = {
      manifest,
      memory: scopedMemory(arbor as unknown as MemoryStore, manifest),
      data: scopedData(dataStore, manifest),
      llm: scopedLlm(llm, manifest),
      files: {
        read: (name) => readJson(safeName(name)),
        write: async (name, value) => {
          await mkdir(filesDir, { recursive: true });
          await writeJson(safeName(name), value);
        },
      },
      secrets: {
        get: async () => (await readJson<Record<string, string>>(secretFile)) ?? {},
        set: async (values) => {
          const next = { ...((await readJson<Record<string, string>>(secretFile)) ?? {}) };
          for (const [k, v] of Object.entries(values)) {
            if (v === null) delete next[k];
            else next[k] = v;
          }
          await mkdir(dirname(secretFile), { recursive: true });
          await writeJson(secretFile, next);
        },
      },
      log: (message) => app.log.info({ module: manifest.id }, message),
      route(method, path, handler) {
        app.route({
          method,
          url: `/api/m/${manifest.id}${path.startsWith("/") ? path : `/${path}`}`,
          handler: (req) =>
            handler({
              params: req.params as Record<string, string>,
              query: req.query as Record<string, string | undefined>,
              body: req.body,
            }),
        });
      },
    };
    try {
      const entry = await import(pathToFileURL(join(modulesDir, mod.dir, serverEntry)).href);
      if (typeof entry.register !== "function") throw new Error("server entry must export register(ctx)");
      await entry.register(ctx);
      serverLoaded.add(manifest.id);
    } catch (err) {
      serverErrors.push({ dir: mod.dir, issues: [{ path: "server", message: String(err) }] });
      app.log.error({ module: manifest.id, err }, "module server entry failed");
    }
  }

  app.get("/api/health", async () => ({
    ok: true,
    name: "Trellis",
    version: "0.1.0",
    vault: { root: join(dataDir, "vault"), initialized: arbor.initialized },
  }));

  app.get("/api/modules", async () => {
    const snap = await loadModules(modulesDir, { disabled: await readDisabled() });
    return {
      modules: snap.modules.map((m) => ({ ...m, serverLoaded: serverLoaded.has(m.manifest.id) })),
      errors: [...snap.errors, ...serverErrors],
    };
  });

  app.get("/api/memory/check", async () => arbor.check());

  // Interface parts hidden on this device. Only UI prefs, no secrets.
  const layoutFile = join(dataDir, "config", "ui-layout.json");
  app.get("/api/ui/layout", async () => (await readJson(layoutFile)) ?? {});
  app.post("/api/ui/layout", async (req) => {
    const h = (req.body as { hidden?: unknown } | null)?.hidden;
    if (!h || typeof h !== "object" || Array.isArray(h)) throw new HttpError(400, "bad layout");
    const hidden: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      if (!/^(nav|section|panel|block):[\w./-]{1,120}$/.test(k) || typeof v !== "string") throw new HttpError(400, `bad layout key ${k}`);
      hidden[k] = v.slice(0, 200);
    }
    if (Object.keys(hidden).length > 500) throw new HttpError(413, "too many hidden items");
    await writeJson(layoutFile, { hidden });
    return { ok: true };
  });

  await app.listen({ host: "127.0.0.1", port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
