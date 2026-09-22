// "Hide parts of the interface" mode: eye toggles, the bottom bar with the hidden list, undo toast.
import { useState } from "react";
import { Check, Eye, EyeOff, SlidersHorizontal, X } from "lucide-react";
import { layout, useLayout } from "@trellis/ui";

export function EyeToggle({ hidden, onClick }: { hidden: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} title={hidden ? "Показать" : "Скрыть"}
      className={`grid size-7 shrink-0 place-items-center rounded-md hover:bg-raised ${hidden ? "text-faint" : "text-accent"}`}>
      {hidden ? <EyeOff size={15} /> : <Eye size={15} />}
    </button>
  );
}

export const KIND: Record<string, string> = { nav: "Меню", section: "Раздел", panel: "Панель", block: "Блок" };

export function EditBar() {
  const { state: ui } = useLayout();
  const [tray, setTray] = useState(false);
  const hidden = Object.entries(ui.hidden);
  const btn = "flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm";

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 flex justify-center px-4">
      <div className="pointer-events-auto w-full max-w-3xl rounded-2xl border border-accent/40 bg-panel/95 p-3 shadow-2xl backdrop-blur">
        {tray && (
          <div className="mb-3 max-h-64 overflow-auto rounded-xl border border-line p-2">
            {!hidden.length && <p className="p-2 text-sm text-faint">Ничего не скрыто.</p>}
            {hidden.map(([key, title]) => (
              <div key={key} className="flex items-center gap-2 rounded-md px-2 py-1 text-sm hover:bg-raised">
                <span className="w-16 shrink-0 text-xs text-faint">{KIND[key.split(":")[0]] ?? "Элемент"}</span>
                <span className="flex-1 truncate">{title}</span>
                <button onClick={() => layout.show(key)} className="flex items-center gap-1 text-xs text-accent"><Eye size={13} /> Показать</button>
              </div>
            ))}
            {hidden.length > 1 && (
              <button onClick={() => layout.showAll()} className="mt-1 px-2 text-xs text-accent">Показать всё</button>
            )}
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <SlidersHorizontal size={17} className="text-accent" />
          <span className="font-semibold">Скрытие разделов</span>
          <span className="text-xs text-faint">глаз скрывает или возвращает · Esc — выход</span>
          <button onClick={() => setTray(!tray)} className={`${btn} ml-auto border ${tray ? "border-accent text-ink" : "border-line text-dim"}`}>
            <EyeOff size={14} /> Скрыто: {hidden.length}
          </button>
          <button onClick={() => layout.setEditing(false)} className={`${btn} bg-accent`}>
            <Check size={14} /> Готово
          </button>
        </div>
      </div>
    </div>
  );
}

export function ToastView({ editing }: { editing: boolean }) {
  const { toast } = useLayout();
  if (!toast) return null;
  return (
    <div key={toast.id} className={`fixed right-4 z-50 flex items-center gap-3 rounded-xl border border-line bg-raised px-4 py-2.5 text-sm shadow-xl ${
      editing ? "bottom-32" : "bottom-4"}`}>
      <span>{toast.text}</span>
      {toast.undo && (
        <button onClick={() => (toast.undo!(), layout.dismissToast())} className="font-medium text-accent">Вернуть</button>
      )}
      <button onClick={() => layout.dismissToast()} className="text-faint hover:text-ink"><X size={14} /></button>
    </div>
  );
}
