import type { ModuleManifest } from "./manifest.ts";
import type { MemoryStore } from "./registry-types.ts";

export class PermissionError extends Error {
  constructor(moduleId: string, permission: string) {
    super(`module ${moduleId} lacks permission ${permission}`);
    this.name = "PermissionError";
  }
}

/** Wraps the vault so a module can only do what its manifest declares. */
export function scopedMemory(store: MemoryStore, manifest: ModuleManifest): MemoryStore {
  const can = (p: string) => (manifest.permissions as string[]).includes(p);
  const deny = (p: string) => () => Promise.reject(new PermissionError(manifest.id, p));
  const read = can("arbor:read") || can("arbor:write");
  const write = can("arbor:write");
  return {
    list: read ? (f) => store.list(f) : deny("arbor:read"),
    get: read ? (id) => store.get(id) : deny("arbor:read"),
    add: write ? (t, i) => store.add(t, i) : deny("arbor:write"),
    update: write ? (id, i) => store.update(id, i) : deny("arbor:write"),
  };
}
