// Node-only core: loads module manifests from disk.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateManifest } from "./manifest.ts";
import type { LoadedModule, RegistryError, RegistrySnapshot } from "./registry-types.ts";

export * from "./index.ts";

export interface LoadOptions {
  /** Module ids switched off in settings. */
  disabled?: Iterable<string>;
}

/** Reads modules/<dir>/module.json. Broken manifests are reported, never fatal. */
export async function loadModules(modulesDir: string, opts: LoadOptions = {}): Promise<RegistrySnapshot> {
  const disabled = new Set(opts.disabled ?? []);
  const modules: LoadedModule[] = [];
  const errors: RegistryError[] = [];
  let dirs: string[] = [];
  try {
    dirs = (await readdir(modulesDir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  for (const dir of dirs.sort()) {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(join(modulesDir, dir, "module.json"), "utf8"));
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      errors.push({ dir, issues: [{ path: "module.json", message: missing ? "missing" : String(err) }] });
      continue;
    }
    const res = validateManifest(raw);
    if (!res.ok) {
      errors.push({ dir, issues: res.issues });
      continue;
    }
    if (res.manifest.id !== dir) {
      errors.push({ dir, issues: [{ path: "id", message: `must match folder name "${dir}"` }] });
      continue;
    }
    modules.push({ manifest: res.manifest, dir, enabled: !disabled.has(res.manifest.id) });
  }
  return { modules, errors };
}
