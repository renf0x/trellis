import { Component, Suspense, type ReactNode } from "react";
import type { ModuleUiProps } from "@trellis/core";
import { api } from "../api.ts";
import { Icon } from "../Icon.tsx";
import { moduleComponent, type ClientModule } from "../modules.ts";

export function ModuleView({ mod, slot, navigate }: {
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

export function Placeholder({ mod, compact }: { mod: ClientModule; compact: boolean }) {
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

export class ErrorBoundary extends Component<{ name: string; children: ReactNode }, { error: Error | null }> {
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
