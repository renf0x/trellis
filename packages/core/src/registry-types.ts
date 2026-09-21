import type { ManifestIssue, ModuleManifest } from "./manifest.ts";

export interface LoadedModule {
  manifest: ModuleManifest;
  /** Folder name under modules/. */
  dir: string;
  enabled: boolean;
}

export interface RegistryError {
  dir: string;
  issues: ManifestIssue[];
}

export interface RegistrySnapshot {
  modules: LoadedModule[];
  errors: RegistryError[];
}

/** Arbor vault as seen by modules; `arbor-bridge` implements it. */
export interface MemoryEntry {
  id: string;
  type: string;
  title: string;
  status: string;
  fields: Record<string, string>;
}
export interface MemoryInput {
  title?: string;
  status?: string;
  fields?: Record<string, string>;
}
export interface MemoryStore {
  list(filter?: { type?: string[]; status?: string[]; limit?: number }): Promise<MemoryEntry[]>;
  get(id: string): Promise<MemoryEntry>;
  add(type: string, input: MemoryInput): Promise<MemoryEntry>;
  update(id: string, input: MemoryInput): Promise<MemoryEntry>;
}

export interface RouteRequest {
  params: Record<string, string>;
  query: Record<string, string | undefined>;
  body: unknown;
}

/** Thrown by module handlers to answer with a 4xx instead of 500. */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** Handed to a module's server entry `register(ctx)`. Framework-neutral on purpose. */
export interface ServerModuleContext {
  manifest: ModuleManifest;
  /** Mounted under /api/m/<module-id><path>. */
  route(method: "GET" | "POST" | "PATCH" | "DELETE", path: string,
    handler: (req: RouteRequest) => Promise<unknown>): void;
  /** Read-only unless the manifest grants arbor:write. */
  memory: MemoryStore;
  log(message: string): void;
}

/** Props every module UI component receives from the shell. */
export interface ModuleUiProps {
  slot: "center" | "right-panel" | "dashboard-widget" | "settings-page";
  manifest: ModuleManifest;
  api: {
    get<T>(path: string): Promise<T>;
    post<T>(path: string, body?: unknown): Promise<T>;
    patch<T>(path: string, body?: unknown): Promise<T>;
  };
  /** Open another module's center view by id. */
  navigate(moduleId: string): void;
}
