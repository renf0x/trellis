import { MessagesSquare } from "lucide-react";
import type { ModuleUiProps } from "@trellis/core";
import { ChatPanel } from "@trellis/ui";

export default function DevChat({ api, navigate, slot }: ModuleUiProps) {
  return (
    <ChatPanel
      bucket="dev"
      title="Чат по доработкам"
      icon={<div className="grid size-8 place-items-center rounded-lg bg-accent-soft text-accent"><MessagesSquare size={18} /></div>}
      intro="Обсуждение доработок самого Trellis. У этого чата своя модель и своя статистика затрат (корзина dev)."
      placeholder="Опишите идею или вопрос по доработке…"
      compact={slot !== "center"}
      api={api}
      navigate={navigate}
    />
  );
}
