import { SlidersHorizontal, TriangleAlert } from "lucide-react";
import { SECTIONS, sectionsOf, type SectionId } from "@trellis/core";
import { layout, useLayout } from "@trellis/ui";
import { Icon } from "../Icon.tsx";
import type { ClientModule } from "../modules.ts";
import { EyeToggle } from "./EditBar.tsx";

export function Sidebar({ modules, activeId, onSelect, errorCount }: {
  modules: ClientModule[];
  activeId: string;
  onSelect: (id: string) => void;
  errorCount: number;
}) {
  const { state: ui, editing } = useLayout();
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
      {groups.map((g) => {
        const secKey = `section:${g.section}`;
        const secHidden = secKey in ui.hidden;
        const items = g.items.filter((i) => editing || !(`nav:${i.m.manifest.id}` in ui.hidden));
        if (!items.length || (secHidden && !editing)) return null;
        const title = SECTIONS[g.section];
        return (
          <div key={g.section} className={secHidden ? "opacity-45" : ""}>
            <div className="flex items-center gap-1 px-3 pb-1.5 text-[13px] text-dim">
              <span className={`flex-1 ${secHidden ? "line-through" : ""}`}>{title}</span>
              {editing && <EyeToggle hidden={secHidden} onClick={() => layout.toggle(secKey, `Раздел «${title}»`)} />}
            </div>
            {items.map(({ m, label }) => {
              const id = m.manifest.id;
              const hid = `nav:${id}` in ui.hidden;
              const on = id === activeId;
              return (
                <div key={id} className="flex items-center">
                  <button
                    onClick={() => onSelect(id)}
                    className={`flex min-w-0 flex-1 items-center gap-3 rounded-lg px-3 py-2 text-left text-[14px] transition-colors ${
                      hid ? "opacity-45" : ""} ${
                      on ? "bg-accent-soft text-ink ring-1 ring-accent/40" : "text-dim hover:bg-raised hover:text-ink"
                    }`}
                  >
                    <Icon name={m.manifest.icon} />
                    <span className={`flex-1 truncate ${hid ? "line-through" : ""}`}>{label}</span>
                    {!m.manifest.ui && <span className="size-1.5 rounded-full bg-faint" title="Заглушка" />}
                  </button>
                  {editing && <EyeToggle hidden={hid} onClick={() => layout.toggle(`nav:${id}`, label)} />}
                </div>
              );
            })}
          </div>
        );
      })}
      {errorCount > 0 && (
        <button onClick={() => onSelect("overview")} className="mx-3 flex items-center gap-2 text-xs text-warn">
          <TriangleAlert size={14} /> Ошибки модулей: {errorCount}
        </button>
      )}
      <div className="mt-auto flex items-center px-3 pt-2">
        <span className="flex-1 text-[11px] text-faint">Created by R:40X</span>
        <button onClick={() => layout.setEditing(!editing)} title="Скрыть или вернуть разделы" className="text-faint hover:text-ink">
          <SlidersHorizontal size={15} />
        </button>
      </div>
    </nav>
  );
}
