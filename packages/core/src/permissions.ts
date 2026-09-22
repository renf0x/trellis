import type { ModuleManifest } from "./manifest.ts";
import type { ModuleLlm } from "./llm.ts";
import type { DataStore, MemoryStore } from "./registry-types.ts";

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

export function scopedData(store: DataStore, manifest: ModuleManifest): DataStore {
  const can = (p: string) => (manifest.permissions as string[]).includes(p);
  const deny = (p: string) => () => Promise.reject(new PermissionError(manifest.id, p));
  const read = can("sources:read") || can("data:write");
  return {
    sources: read ? () => store.sources() : deny("sources:read"),
    docs: read ? () => store.docs() : deny("sources:read"),
    cases: read ? () => store.cases() : deny("sources:read"),
    replace: can("data:write") ? (s) => store.replace(s) : deny("data:write"),
  };
}

export function scopedLlm(llm: ModuleLlm, manifest: ModuleManifest): ModuleLlm {
  if ((manifest.permissions as string[]).includes("llm:main")) return llm;
  const deny = () => Promise.reject(new PermissionError(manifest.id, "llm:main"));
  return { chatModel: deny, complete: deny, decide: deny, analysis: deny };
}
