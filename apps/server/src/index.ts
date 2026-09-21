// Trellis local server: module registry, Arbor runtime vault, module routes.
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import Fastify from "fastify";
import { ArborBridge, ArborError } from "@trellis/arbor-bridge";
import {
  HttpError,
  PermissionError,
  loadModules,
  scopedMemory,
  type MemoryStore,
  type RegistrySnapshot,
  type ServerModuleContext,
} from "@trellis/core/node";
import { LlmError } from "@trellis/llm";
import { registerLlm } from "./llm.ts";

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

async function main() {
  await mkdir(join(dataDir, "config"), { recursive: true });
  const arbor = new ArborBridge({ root: join(dataDir, "vault"), script: join(repoRoot, "arbor.py") });
  if (!arbor.initialized) await arbor.init();

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

  // Server entries are loaded once at start; manifests are re-read on each /api/modules call.
  const startup = await loadModules(modulesDir, { disabled: await readDisabled() });
  const serverLoaded = new Set<string>();
  const serverErrors: RegistrySnapshot["errors"] = [];

  for (const mod of startup.modules) {
    const { manifest } = mod;
    const serverEntry = manifest.server;
    if (!mod.enabled || !serverEntry) continue;
    const ctx: ServerModuleContext = {
      manifest,
      memory: scopedMemory(arbor as unknown as MemoryStore, manifest),
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
  await registerLlm(app, dataDir);

  await app.listen({ host: "127.0.0.1", port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
