// The only way Trellis talks to an Arbor vault. Spawns `python arbor.py memory ...`.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type EntryType = "TASK" | "BUG" | "DEC" | "INV" | "IDEA" | "KNW" | "CHG";

export interface ArborEntry {
  id: string;
  type: EntryType;
  title: string;
  status: string;
  fields: Record<string, string>;
  note?: string;
}

export interface EntryInput {
  title?: string;
  status?: string;
  fields?: Record<string, string>;
}

export interface ArborBridgeOptions {
  /** Vault root; notes live in <root>/memory. */
  root: string;
  /** Path to arbor.py. */
  script: string;
  python?: string;
  timeoutMs?: number;
}

export class ArborError extends Error {
  constructor(message: string, readonly code: number | null, readonly stderr: string) {
    super(message);
    this.name = "ArborError";
  }
}

export class ArborBridge {
  private readonly python: string;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ArborBridgeOptions) {
    this.python = opts.python ?? process.env.TRELLIS_PYTHON ?? (process.platform === "win32" ? "python" : "python3");
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  get initialized(): boolean {
    return existsSync(join(this.opts.root, "memory"));
  }

  async init(): Promise<void> {
    await this.run(["memory", "init", this.opts.root]);
  }

  async check(): Promise<{ ok: boolean; [k: string]: unknown }> {
    // `check` exits non-zero on problems but still prints JSON.
    const out = await this.run(["memory", "check", this.opts.root, "--json"], undefined, true);
    return JSON.parse(out);
  }

  async add(type: EntryType, input: EntryInput): Promise<ArborEntry> {
    return this.json(["add", "--type", type, "--input-json"], input);
  }

  async get(id: string): Promise<ArborEntry> {
    return this.json(["get", id]);
  }

  async list(filter: { type?: EntryType[]; status?: string[]; includeArchive?: boolean; limit?: number } = {}): Promise<ArborEntry[]> {
    const args = ["list"];
    if (filter.type?.length) args.push("--type", filter.type.join(","));
    if (filter.status?.length) args.push("--status", filter.status.join(","));
    if (filter.includeArchive) args.push("--include-archive");
    if (filter.limit) args.push("--limit", String(filter.limit));
    return (await this.json<{ entries: ArborEntry[] }>(args)).entries;
  }

  async update(id: string, input: EntryInput): Promise<ArborEntry> {
    return this.json(["update", id, "--input-json"], input);
  }

  async close(id: string, status?: string): Promise<ArborEntry> {
    return this.json(status ? ["close", id, "--status", status] : ["close", id]);
  }

  async delete(id: string): Promise<void> {
    await this.json(["delete", id, "--yes"]);
  }

  async prune(olderThanMonths: number, dryRun = false): Promise<{ removed: string[] }> {
    const args = ["prune", "--older-than-months", String(olderThanMonths)];
    if (dryRun) args.push("--dry-run");
    return this.json(args);
  }

  private async json<T>(args: string[], stdin?: unknown): Promise<T> {
    const out = await this.run(["memory", ...args, "--path", this.opts.root, "--json"], stdin);
    return JSON.parse(out) as T;
  }

  private run(args: string[], stdin?: unknown, allowFailure = false): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.python, ["-X", "utf8", this.opts.script, ...args], {
        env: { ...process.env, PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill();
        reject(new ArborError(`arbor ${args[1]} timed out`, null, stderr));
      }, this.timeoutMs);
      child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(new ArborError(`cannot start ${this.python}: ${err.message}`, null, ""));
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0 || allowFailure) resolve(stdout);
        else reject(new ArborError((stderr || stdout).trim() || `arbor exited with ${code}`, code, stderr));
      });
      child.stdin.end(stdin === undefined ? "" : JSON.stringify(stdin), "utf8");
    });
  }
}
