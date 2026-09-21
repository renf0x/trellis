import { Component, Suspense, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Bell, ChevronDown, Search, Settings as Gear, Sprout, TriangleAlert } from "lucide-react";
import { SECTIONS, sectionsOf, type ModuleUiProps, type SectionId } from "@trellis/core";
import { api } from "./api.ts";
import { Icon } from "./Icon.tsx";
import { moduleComponent, type ClientModule, type ModulesResponse } from "./modules.ts";

const initialId = () => decodeURIComponent(location.hash.replace(/^#\/?/, "")) || "overview";

export function App() {
  const [registry, setRegistry] = useState<ModulesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState(initialId);

  const reload = useCallback(() => {
    api.get<ModulesResponse>("/api/modules").then(setRegistry, (e: Error) => setLoadError(e.message));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => {
    const onHash = () => setActiveId(initialId());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  const navigate = useCallback((id: string) => {
    location.hash = `/${id}`;
  }, []);

  const enabled = useMemo(() => registry?.modules.filter((m) => m.enabled) ?? [], [registry]);
  const active = enabled.find((m) => m.manifest.id === activeId);
  const activeSection: SectionId =
    active?.manifest.slots.map(sectionsOf).find((s) => s.length)?.[0] ?? "work";
  const panels = enabled
    .flatMap((m) => m.manifest.slots.filter((s) => s.slot === "right-panel").map((s) => ({ m, s })))
    // The active module is already in the center; don't repeat it on the right.
    .filter(({ m, s }) => m !== active && sectionsOf(s).includes(activeSection))
    .sort((a, b) => (a.s.order ?? 100) - (b.s.order ?? 100))
    .map(({ m }) => m);

  if (loadError && !registry) return <Offline message={loadError} onRetry={() => { setLoadError(null); reload(); }} />;

  return (
    <div className="flex h-full flex-col">
      <Topbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar modules={enabled} activeId={activeId} onSelect={navigate} errorCount={registry?.errors.length ?? 0} />
        <main className="min-w-0 flex-1 overflow-auto p-5">
          {!registry ? (
            <p className="text-dim">Загрузка модулей…</p>
          ) : active ? (
            <ModuleView mod={active} slot="center" navigate={navigate} />
          ) : (
            <p className="text-dim">Модуль «{activeId}» не найден или отключён.</p>
          )}
        </main>
        {panels.length > 0 && (
          <aside className="flex w-[380px] shrink-0 flex-col gap-4 overflow-auto border-l border-line p-4">
            {panels.map((m) => (
              <ModuleView key={m.manifest.id} mod={m} slot="right-panel" navigate={navigate} />
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}

function Topbar() {
  return (
    <header className="flex h-16 shrink-0 items-center gap-6 border-b border-line px-5">
      <div className="flex w-[228px] items-center gap-3">
        <div className="grid size-9 place-items-center rounded-xl bg-accent-soft text-accent">
          <Sprout size={20} />
        </div>
        <div className="leading-tight">
          <div className="flex items-center gap-2 text-lg font-semibold">
            Trellis <span className="rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-medium">v0.1</span>
          </div>
          <div className="text-xs text-faint">Docs · Tests · AI</div>
        </div>
      </div>
      <label className="flex h-10 max-w-xl flex-1 items-center gap-2 rounded-lg border border-line bg-panel px-3 text-dim">
        <Search size={16} />
        <input
          disabled
          placeholder="Поиск по документации, тестам, задачам… (этап 3)"
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-faint"
        />
        <kbd className="rounded border border-line px-1.5 text-[11px] text-faint">Ctrl+K</kbd>
      </label>
      <div className="ml-auto flex items-center gap-4 text-dim">
        <button className="flex h-9 items-center gap-2 rounded-lg border border-line px-3 text-sm" disabled>
          Рабочая область <ChevronDown size={14} />
        </button>
        <Bell size={18} />
        <a href="#/settings" title="Настройки"><Gear size={18} /></a>
      </div>
    </header>
  );
}

function Sidebar({ modules, activeId, onSelect, errorCount }: {
  modules: ClientModule[];
  activeId: string;
  onSelect: (id: string) => void;
  errorCount: number;
}) {
  const groups = (Object.keys(SECTIONS) as SectionId[]).map((section) => ({
    section,
    items: modules
      .flatMap((m) =>
        m.manifest.slots
          .filter((s) => s.slot === "sidebar" && sectionsOf(s).includes(section))
          .map((s) => ({ m, label: s.label ?? m.manifest.title, order: s.order ?? 100 })))
      .sort((a, b) => a.order - b.order),
  }));

  return (
    <nav className="flex w-[260px] shrink-0 flex-col gap-5 overflow-auto border-r border-line p-3">
      {groups.filter((g) => g.items.length).map((g) => (
        <div key={g.section}>
          <div className="px-3 pb-1.5 text-[13px] text-dim">{SECTIONS[g.section]}</div>
          {g.items.map(({ m, label }) => {
            const on = m.manifest.id === activeId;
            return (
              <button
                key={m.manifest.id}
                onClick={() => onSelect(m.manifest.id)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] transition-colors ${
                  on ? "bg-accent-soft text-ink ring-1 ring-accent/40" : "text-dim hover:bg-raised hover:text-ink"
                }`}
              >
                <Icon name={m.manifest.icon} />
                <span className="flex-1 truncate">{label}</span>
                {!m.manifest.ui && <span className="size-1.5 rounded-full bg-faint" title="Заглушка" />}
              </button>
            );
          })}
        </div>
      ))}
      {errorCount > 0 && (
        <button onClick={() => onSelect("overview")} className="mx-3 flex items-center gap-2 text-xs text-warn">
          <TriangleAlert size={14} /> Ошибки модулей: {errorCount}
        </button>
      )}
      <div className="mt-auto px-3 pt-2 text-[11px] text-faint">Created by R:40X</div>
    </nav>
  );
}

function ModuleView({ mod, slot, navigate }: {
  mod: ClientModule;
  slot: ModuleUiProps["slot"];
  navigate: (id: string) => void;
}) {
  const Comp = moduleComponent(mod);
  if (!Comp) return <Placeholder mod={mod} compact={slot !== "center"} />;
  return (
    <ErrorBoundary key={mod.manifest.id} name={mod.manifest.title}>
      <Suspense fallback={<p className="text-dim">Загрузка «{mod.manifest.title}»…</p>}>
        <Comp slot={slot} manifest={mod.manifest} api={api} navigate={navigate} />
      </Suspense>
    </ErrorBoundary>
  );
}

function Placeholder({ mod, compact }: { mod: ClientModule; compact: boolean }) {
  const { manifest } = mod;
  return (
    <section className={`rounded-xl border border-line bg-panel ${compact ? "p-4" : "p-8"}`}>
      <div className="flex items-center gap-3">
        <div className="grid size-10 place-items-center rounded-lg bg-raised text-accent">
          <Icon name={manifest.icon} size={20} />
        </div>
        <div>
          <h2 className={compact ? "font-semibold" : "text-xl font-semibold"}>{manifest.title}</h2>
          {manifest.stage !== undefined && <div className="text-xs text-faint">Появится на этапе {manifest.stage}</div>}
        </div>
      </div>
      {manifest.description && <p className="mt-3 text-dim">{manifest.description}</p>}
      {!compact && (
        <p className="mt-4 text-xs text-faint">
          Модуль <code>modules/{mod.dir}</code> пока без интерфейса: в манифесте нет поля <code>ui</code>.
        </p>
      )}
    </section>
  );
}

class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <section className="rounded-xl border border-bad/40 bg-panel p-4 text-sm">
        <div className="font-medium text-bad">Модуль «{this.props.name}» упал</div>
        <pre className="mt-2 whitespace-pre-wrap text-dim">{this.state.error.message}</pre>
      </section>
    );
  }
}

function Offline({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-md rounded-xl border border-line bg-panel p-6 text-center">
        <div className="text-lg font-semibold">Сервер Trellis недоступен</div>
        <p className="mt-2 text-dim">{message}</p>
        <p className="mt-2 text-xs text-faint">Запустите <code>npm run dev</code> в корне проекта.</p>
        <button onClick={onRetry} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm">Повторить</button>
      </div>
    </div>
  );
}
