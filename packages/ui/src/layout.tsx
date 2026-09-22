// Per-device hiding of interface parts. Kept in localStorage for an instant first paint and in
// data/config/ui-layout.json on the local server, so it survives a browser switch.
// Hiding deletes nothing: every hidden item can be shown again.
import { useSyncExternalStore, type ReactNode } from "react";
import { Eye, EyeOff } from "lucide-react";

/**
 * Keys: `nav:<module>` sidebar item, `section:<id>` sidebar group, `panel:<module>` right panel,
 * `block:<module>/<block>` a part of a module screen. The value is the title shown in the "hidden" list.
 */
export interface Layout {
  hidden: Record<string, string>;
}
export interface Toast { id: number; text: string; undo?: () => void }

const LS_KEY = "trellis.layout";
const URL = "/api/ui/layout";

function clean(raw: unknown): Layout {
  const h = (raw as Partial<Layout> | null)?.hidden;
  const hidden: Record<string, string> = {};
  if (h && typeof h === "object") for (const [k, v] of Object.entries(h)) if (typeof v === "string") hidden[k] = v;
  return { hidden };
}

function readLocal(): Layout | null {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? clean(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

let state: Layout = readLocal() ?? { hidden: {} };
let editing = false;
let toast: Toast | null = null;
let snapshot: { state: Layout; editing: boolean; toast: Toast | null } = { state, editing, toast };
const subs = new Set<() => void>();
const emit = () => {
  snapshot = { state, editing, toast };
  subs.forEach((f) => f());
};

let saveTimer: ReturnType<typeof setTimeout> | undefined;
function push() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void fetch(URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) }).catch(() => {});
  }, 400);
}
function commit(next: Layout) {
  state = next;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch {
    // private window or blocked storage: the server copy still works
  }
  emit();
  push();
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function say(text: string, undo?: () => void) {
  clearTimeout(toastTimer);
  toast = { id: Date.now(), text, undo };
  emit();
  toastTimer = setTimeout(() => ((toast = null), emit()), 5000);
}

/** Loads the server copy once; if the server has none yet, it gets the local one. */
export async function syncLayout() {
  try {
    const res = await fetch(URL);
    if (!res.ok) return;
    const remote = await res.json();
    if (remote && typeof remote === "object" && "hidden" in remote) {
      state = clean(remote);
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(state));
      } catch {
        // ignore
      }
      emit();
    } else if (readLocal()) {
      push();
    }
  } catch {
    // offline: keep the local copy
  }
}

export const layout = {
  isHidden: (key: string) => key in state.hidden,
  hide(key: string, title: string) {
    commit({ hidden: { ...state.hidden, [key]: title } });
    say(`Скрыто: ${title}`, () => layout.show(key));
  },
  show(key: string) {
    const hidden = { ...state.hidden };
    delete hidden[key];
    commit({ hidden });
  },
  toggle(key: string, title: string) {
    if (key in state.hidden) layout.show(key);
    else layout.hide(key, title);
  },
  showAll() {
    const before = state.hidden;
    commit({ hidden: {} });
    say("Всё скрытое снова видно", () => commit({ hidden: before }));
  },
  setEditing(on: boolean) {
    editing = on;
    emit();
  },
  dismissToast() {
    toast = null;
    emit();
  },
};

const subscribe = (f: () => void) => (subs.add(f), () => void subs.delete(f));
export function useLayout() {
  return useSyncExternalStore(subscribe, () => snapshot);
}

/**
 * A hideable part of a module screen. In the "customize" mode it gets an eye button;
 * a hidden block leaves a stub there and is listed in "Скрыто", so it can always come back.
 */
export function Block({ id, title, children, className }: { id: string; title: string; children: ReactNode; className?: string }) {
  return <Hideable hideKey={`block:${id}`} title={title} className={className}>{children}</Hideable>;
}

export function Hideable({ hideKey, title, children, className = "" }: {
  hideKey: string; title: string; children: ReactNode; className?: string;
}) {
  const { state: s, editing: e } = useLayout();
  const hidden = hideKey in s.hidden;
  if (!e) return hidden ? null : <>{children}</>;
  return (
    <div className={`relative rounded-xl outline-dashed outline-1 outline-offset-4 ${hidden ? "outline-line" : "outline-accent/60"} ${className}`}>
      <button
        onClick={() => layout.toggle(hideKey, title)}
        title={hidden ? "Показать" : "Скрыть"}
        className="absolute -top-3 right-3 z-20 flex items-center gap-1 rounded-full border border-line bg-raised px-2 py-0.5 text-[11px] text-dim shadow hover:text-ink"
      >
        {hidden ? <Eye size={12} /> : <EyeOff size={12} />} {hidden ? "Показать" : "Скрыть"}
      </button>
      {hidden ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-3 text-sm text-faint">Скрыто: {title}</div>
      ) : children}
    </div>
  );
}
