import { Bot } from "lucide-react";
import type { ModuleUiProps } from "@trellis/core";
import { ChatPanel } from "@trellis/ui";

// Side chat for general questions and ideas. Reports go to the big chat of «Рабочее место» (one tab each).
// Modules extend it through `chat` in their module.json: extra prompt text and buttons under messages.
export default function AgentChat({ api, navigate, slot }: ModuleUiProps) {
  return (
    <ChatPanel
      channel="main"
      title="AI QA агент"
      icon={<div className="grid size-8 place-items-center rounded-lg bg-ok/15 text-ok"><Bot size={18} /></div>}
      intro="Общие вопросы по тестированию и приложению, идеи. Разбор отчётов, находок и правки кейсов и документации — в чате «Рабочего места»: кнопка «В чат» у отчёта открывает там отдельную вкладку."
      placeholder="Вопрос или идея… (Enter — отправить, Shift+Enter — перенос)"
      compact={slot !== "center"}
      api={api}
      navigate={navigate}
    />
  );
}
