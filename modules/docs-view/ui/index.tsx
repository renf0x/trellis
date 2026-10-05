import { useEffect, useMemo, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronRight, CloudDownload, ExternalLink, FileText, MessageSquarePlus, Search } from "lucide-react";
import type { ModuleUiProps, DocRecord, SourceInfo } from "@trellis/core";
import { openInWorkChat } from "@trellis/ui";
import { DocRemarks, RemarksBoard, useRemarks } from "./remarks.tsx";

type Item = Pick<DocRecord, "id" | "source" | "container" | "path" | "title">;
interface ListResponse { sources: SourceInfo[]; total: number; items: Item[] }
interface Node { name: string; path: string; item?: Item; children: Node[] }

const base = "/api/m/docs-view";

/** Builds container → page hierarchy from flat "/A/B" paths. */
function buildTree(items: Item[]): Node[] {
  const roots: Node[] = [];
  const find = (list: Node[], name: string, path: string) => {
    let n = list.find((x) => x.name === name);
    if (!n) list.push((n = { name, path, children: [] }));
    return n;
  };
  for (const it of items) {
    let node = find(roots, it.container, `${it.source}:${it.container}`);
    let acc = "";
    for (const part of it.path.split("/").filter(Boolean)) {
      acc += `/${part}`;
      node = find(node.children, part, `${it.source}:${it.container}:${acc}`);
    }
    node.item = it;
  }
  return roots;
}

export default function DocsView({ api, navigate }: ModuleUiProps) {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<ListResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [doc, setDoc] = useState<DocRecord | null>(null);
  const [mode, setMode] = useState<"pages" | "remarks">("pages");
  const remarks = useRemarks(api);

  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  useEffect(() => {
    api.get<ListResponse>(`${base}/docs?q=${encodeURIComponent(query)}`).then(setData, (e: Error) => setError(e.message));
  }, [api, query]);
  useEffect(() => {
    if (!selected) return setDoc(null);
    api.get<DocRecord>(`${base}/doc?id=${encodeURIComponent(selected)}`).then(setDoc, (e: Error) => setError(e.message));
  }, [api, selected]);
  const tree = useMemo(() => buildTree(data?.items ?? []), [data]);

  if (!data) return <p className="text-dim">{error ?? "Загрузка…"}</p>;
  if (!data.total) return <Empty navigate={navigate} />;

  return (
    <div className="flex h-full min-h-0 gap-4">
      <aside className="flex w-80 shrink-0 flex-col rounded-xl border border-line bg-panel">
        {remarks.available && (
          <div className="mx-3 mt-3 flex rounded-lg border border-line p-0.5 text-sm">
            <button onClick={() => setMode("pages")} className={`flex-1 rounded-md py-1 ${mode === "pages" ? "bg-accent-soft text-ink" : "text-dim hover:text-ink"}`}>Страницы</button>
            <button onClick={() => (setMode("remarks"), void remarks.reload())}
              className={`flex-1 rounded-md py-1 ${mode === "remarks" ? "bg-accent-soft text-ink" : "text-dim hover:text-ink"}`}>
              Замечания{remarks.counts.new > 0 && <span className="ml-1 text-warn">{remarks.counts.new}</span>}
            </button>
          </div>
        )}
        <label className="m-3 flex h-9 items-center gap-2 rounded-lg border border-line bg-raised px-3 text-dim">
          <Search size={15} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Поиск по названию и тексту"
            className="flex-1 bg-transparent text-sm outline-none placeholder:text-faint" />
        </label>
        <div className="px-3 pb-2 text-xs text-faint">
          {query ? `Найдено: ${data.items.length} из ${data.total}` : `Страниц: ${data.total}`}
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2 pb-3">
          {tree.map((n) => <TreeNode key={n.path} node={n} selected={selected} onSelect={(id) => (setSelected(id), setMode("pages"))} depth={0} open={!!query} />)}
        </div>
        <div className="border-t border-line px-3 py-2 text-[11px] text-faint">
          {data.sources.map((s) => <div key={s.source}>{s.title} · {new Date(s.syncedAt).toLocaleString()}</div>)}
        </div>
      </aside>
      <article className="min-w-0 flex-1 overflow-auto rounded-xl border border-line bg-panel p-6">
        {mode === "remarks" ? (
          <RemarksBoard api={api} onOpenDoc={(id) => (setSelected(id), setMode("pages"))} />
        ) : !doc ? (
          <p className="text-faint">Выберите страницу слева.</p>
        ) : (
          <>
            <div className="mb-4 flex items-center gap-2 text-xs text-faint">
              <FileText size={14} className="shrink-0" />
              <span className="min-w-0 truncate" title={`${doc.container}${doc.path}`}>{doc.container}{doc.path}</span>
              <button
                title="Открыть страницу во вкладке чата «Рабочего места»: обсудить её и попросить правку"
                onClick={() => openInWorkChat({ kind: "doc", key: `doc:${doc.id}`, title: doc.title }, { title: `Документ: ${doc.title}`, text: `Документация (id: ${doc.id})\n# ${doc.title}\nПуть: ${doc.container}${doc.path}\n\n${doc.content.slice(0, 12000)}` })}
                className="ml-auto inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-accent">
                <MessageSquarePlus size={12} /> В чат
              </button>
              {doc.url && (
                <a href={doc.url} target="_blank" rel="noreferrer" className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-accent">
                  Открыть в источнике <ExternalLink size={12} />
                </a>
              )}
            </div>
            <h1 className="mb-4 text-2xl font-semibold">{doc.title}</h1>
            <DocRemarks key={doc.id} api={api} docId={doc.id} />
            <div className="md">
              {doc.content.trim() ? <Markdown remarkPlugins={[remarkGfm]}>{doc.content}</Markdown> : <p className="text-faint">Пустая страница.</p>}
            </div>
          </>
        )}
      </article>
    </div>
  );
}

function TreeNode({ node, selected, onSelect, depth, open: forceOpen }: {
  node: Node; selected: string | null; onSelect: (id: string) => void; depth: number; open: boolean;
}) {
  const [open, setOpen] = useState(depth === 0);
  const expanded = open || forceOpen;
  const on = !!node.item && node.item.id === selected;
  return (
    <div>
      <button
        onClick={() => { if (node.item) onSelect(node.item.id); if (node.children.length) setOpen(!expanded); }}
        style={{ paddingLeft: 6 + depth * 14 }}
        className={`flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-sm ${
          on ? "bg-accent-soft text-ink" : depth === 0 ? "font-medium text-ink hover:bg-raised" : "text-dim hover:bg-raised hover:text-ink"}`}
      >
        {node.children.length ? <ChevronRight size={14} className={`shrink-0 ${expanded ? "rotate-90" : ""}`} /> : <span className="w-3.5 shrink-0" />}
        <span className="truncate">{node.name}</span>
      </button>
      {expanded && node.children.map((c) => (
        <TreeNode key={c.path} node={c} selected={selected} onSelect={onSelect} depth={depth + 1} open={forceOpen} />
      ))}
    </div>
  );
}

function Empty({ navigate }: { navigate: (id: string) => void }) {
  return (
    <section className="max-w-xl rounded-xl border border-line bg-panel p-8">
      <h1 className="text-xl font-semibold">Документация</h1>
      <p className="mt-2 text-dim">Документов пока нет. Подключите Confluence и загрузите страницы в приложение.</p>
      <button onClick={() => navigate("connector-confluence")} className="mt-4 flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm">
        <CloudDownload size={16} /> Перейти к Confluence
      </button>
    </section>
  );
}
