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

/** Normalized records imported from a source (Azure DevOps, local files). Ids are `<source>:<external id>`. */
export interface DocRecord {
  id: string;
  source: string;
  /** Wiki or folder name the page belongs to. */
  container: string;
  /** "/Parent/Page" inside the container. */
  path: string;
  title: string;
  content: string;
  url?: string;
}
export interface TestStepRecord {
  kind: "step" | "shared";
  action: string;
  expected: string;
}
export interface TestCaseRecord {
  id: string;
  source: string;
  externalId: string;
  title: string;
  state: string;
  priority?: number;
  /** "Plan / Suite / Sub-suite" for every suite that contains the case. */
  suites: string[];
  steps: TestStepRecord[];
  url?: string;
}
export interface SourceSnapshot {
  source: string;
  title: string;
  syncedAt: string;
  docs: DocRecord[];
  cases: TestCaseRecord[];
}
export interface SourceInfo {
  source: string;
  title: string;
  syncedAt: string;
  docs: number;
  cases: number;
}
/** Local copy of source data; `replace` swaps a whole source atomically. */
export interface DataStore {
  sources(): Promise<SourceInfo[]>;
  docs(): Promise<DocRecord[]>;
  cases(): Promise<TestCaseRecord[]>;
  replace(snapshot: SourceSnapshot): Promise<void>;
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
  /** Imported docs and cases: reading needs sources:read, replace needs data:write. */
  data: DataStore;
  /** JSON files private to the module, under data/modules/<id>/. */
  files: {
    read<T>(name: string): Promise<T | null>;
    write(name: string, value: unknown): Promise<void>;
  };
  /** Module secrets in data/secrets/modules/<id>.json; never send them to the browser. */
  secrets: {
    get(): Promise<Record<string, string>>;
    /** Merges values; null removes a key. */
    set(values: Record<string, string | null>): Promise<void>;
  };
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
