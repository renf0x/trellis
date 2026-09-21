import { useEffect, useState } from "react";
import { CircleCheck, CircleDashed, CircleOff, Database, TriangleAlert } from "lucide-react";
import type { LoadedModule, ModuleUiProps, RegistryError } from "@trellis/core";

interface Health {
  version: string;
  vault: { root: string; initialized: boolean };
}
type Mod = LoadedModule & { serverLoaded: boolean };

export default function Overview({ api, navigate }: ModuleUiProps) {
  const [health, setHealth] = useState<Health | null>(null);
  const [check, setCheck] = useState<{ ok: boolean; issues: string[] } | null>(null);
  const [reg, setReg] = useState<{ modules: Mod[]; errors: RegistryError[] } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fail = (e: Error) => setError(e.message);
    api.get<Health>("/api/health").then(setHealth, fail);
    api.get<{ ok: boolean; issues: string[] }>("/api/memory/check").then(setCheck, fail);
    api.get<{ modules: Mod[]; errors: RegistryError[] }>("/api/modules").then(setReg, fail);
  }, [api]);

  const live = reg?.modules.filter((m) => m.enabled && m.manifest.ui) ?? [];
  const stubs = reg?.modules.filter((m) => m.enabled && !m.manifest.ui) ?? [];

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">Обзор</h1>
        <p className="mt-1 text-dim">Ядро Trellis и подключённые модули. Каждый модуль лежит в <code>modules/&lt;id&gt;</code>.</p>
      </div>
      {error && <p className="text-bad">{error}</p>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <Stat label="Модули с интерфейсом" value={live.length} />
        <Stat label="Заглушки" value={stubs.length} />
        <Stat label="Ошибки манифестов" value={reg?.errors.length ?? 0} bad={!!reg?.errors.length} />
      </div>

      <section className="rounded-xl border border-line bg-panel p-4">
        <h2 className="flex items-center gap-2 font-semibold"><Database size={16} /> Память (Arbor)</h2>
        <p className="mt-2 text-sm text-dim">
          Vault: <code className="text-ink">{health?.vault.root ?? "…"}</code>
        </p>
        <p className="mt-1 text-sm">
          {check === null ? "Проверка…" : check.ok
            ? <span className="text-ok">memory check: OK</span>
            : <span className="text-warn">memory check: {check.issues.join("; ")}</span>}
        </p>
      </section>

      <section className="rounded-xl border border-line bg-panel p-4">
        <h2 className="font-semibold">Модули</h2>
        <ul className="mt-2 divide-y divide-line">
          {reg?.modules.map((m) => (
            <li key={m.dir} className="flex items-center gap-3 py-2 text-sm">
              {!m.enabled ? <CircleOff size={16} className="text-faint" />
                : m.manifest.ui ? <CircleCheck size={16} className="text-ok" />
                : <CircleDashed size={16} className="text-faint" />}
              <button onClick={() => navigate(m.manifest.id)} className="hover:text-accent">{m.manifest.title}</button>
              <code className="text-xs text-faint">{m.manifest.id}</code>
              <span className="ml-auto text-xs text-faint">
                {m.serverLoaded && "сервер · "}
                {m.manifest.ui ? "интерфейс" : m.manifest.stage !== undefined ? `этап ${m.manifest.stage}` : "заглушка"}
              </span>
            </li>
          ))}
        </ul>
        {reg?.errors.map((e) => (
          <div key={e.dir} className="mt-3 rounded-lg border border-warn/30 p-3 text-sm">
            <div className="flex items-center gap-2 text-warn"><TriangleAlert size={14} /> modules/{e.dir}</div>
            <ul className="mt-1 text-dim">
              {e.issues.map((i, n) => <li key={n}><code>{i.path}</code>: {i.message}</li>)}
            </ul>
          </div>
        ))}
      </section>
    </div>
  );
}

function Stat({ label, value, bad }: { label: string; value: number; bad?: boolean }) {
  return (
    <div className="rounded-xl border border-line bg-panel p-4">
      <div className="text-sm text-dim">{label}</div>
      <div className={`mt-1 text-3xl font-semibold ${bad ? "text-warn" : ""}`}>{value}</div>
    </div>
  );
}
