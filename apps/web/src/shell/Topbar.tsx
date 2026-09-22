import { Bell, Search, Settings as Gear, SlidersHorizontal, Sprout } from "lucide-react";
import { layout } from "@trellis/ui";

export function Topbar({ editing }: { editing: boolean }) {
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
        <button
          onClick={() => layout.setEditing(!editing)}
          title="Скрыть ненужные разделы и блоки или вернуть скрытое"
          className={`flex h-9 items-center gap-2 rounded-lg border px-3 text-sm transition-colors ${
            editing ? "border-accent bg-accent-soft text-ink" : "border-line hover:text-ink"}`}
        >
          <SlidersHorizontal size={15} /> {editing ? "Настраиваю…" : "Интерфейс"}
        </button>
        <Bell size={18} />
        <a href="#/settings" title="Настройки"><Gear size={18} /></a>
      </div>
    </header>
  );
}
