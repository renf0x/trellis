import { useCallback, useEffect, useMemo, useState } from "react";
import { sectionsOf, type SectionId } from "@trellis/core";
import { Hideable, layout, syncLayout, useLayout } from "@trellis/ui";
import { api } from "./api.ts";
import type { ModulesResponse } from "./modules.ts";
import { EditBar, ToastView } from "./shell/EditBar.tsx";
import { ModuleView } from "./shell/ModuleView.tsx";
import { Offline } from "./shell/Offline.tsx";
import { Sidebar } from "./shell/Sidebar.tsx";
import { Topbar } from "./shell/Topbar.tsx";

const initialId = () => decodeURIComponent(location.hash.replace(/^#\/?/, "")) || "overview";

export function App() {
  const [registry, setRegistry] = useState<ModulesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [activeId, setActiveId] = useState(initialId);
  const { state: ui, editing } = useLayout();

  const reload = useCallback(() => {
    api.get<ModulesResponse>("/api/modules").then(setRegistry, (e: Error) => setLoadError(e.message));
  }, []);
  useEffect(reload, [reload]);
  useEffect(() => void syncLayout(), []);
  useEffect(() => {
    const onHash = () => setActiveId(initialId());
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && layout.setEditing(false);
    addEventListener("hashchange", onHash);
    addEventListener("keydown", onKey);
    return () => {
      removeEventListener("hashchange", onHash);
      removeEventListener("keydown", onKey);
    };
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
    .map(({ m }) => m)
    .filter((m) => editing || !(`panel:${m.manifest.id}` in ui.hidden));

  if (loadError && !registry) return <Offline message={loadError} onRetry={() => { setLoadError(null); reload(); }} />;

  return (
    <div className="flex h-full flex-col">
      <Topbar editing={editing} />
      <div className="flex min-h-0 flex-1">
        <Sidebar modules={enabled} activeId={activeId} onSelect={navigate} errorCount={registry?.errors.length ?? 0} />
        <main className={`min-w-0 flex-1 overflow-auto p-5 ${editing ? "pb-48" : ""}`}>
          {!registry ? (
            <p className="text-dim">Загрузка модулей…</p>
          ) : active ? (
            <ModuleView mod={active} slot="center" navigate={navigate} />
          ) : (
            <p className="text-dim">Модуль «{activeId}» не найден или отключён.</p>
          )}
        </main>
        {panels.length > 0 && (
          <aside className={`flex w-[380px] shrink-0 flex-col gap-4 overflow-auto border-l border-line p-4 ${editing ? "pt-6 pb-48" : ""}`}>
            {panels.map((m) => (
              <Hideable key={m.manifest.id} hideKey={`panel:${m.manifest.id}`} title={`Панель: ${m.manifest.title}`}>
                <ModuleView mod={m} slot="right-panel" navigate={navigate} />
              </Hideable>
            ))}
          </aside>
        )}
      </div>
      {editing && <EditBar />}
      <ToastView editing={editing} />
    </div>
  );
}
