import { Bot } from "lucide-react";
import type { ModuleUiProps } from "@trellis/core";
import { ChatPanel } from "@trellis/ui";

// Plain chat for now; the tool loop (docs, cases, compare, Playwright) arrives with the agent stage.
export default function AgentChat({ api, navigate, slot }: ModuleUiProps) {
  return (
    <ChatPanel
      bucket="main"
      title="AI QA агент"
      icon={<div className="grid size-8 place-items-center rounded-lg bg-ok/15 text-ok"><Bot size={18} /></div>}
      intro="Спросите про документацию или тест-кейсы. Инструменты агента (сравнение, Playwright) подключаются следующими задачами; сейчас это чат с выбранной моделью."
      placeholder="Сообщение агенту… (Enter — отправить, Shift+Enter — перенос)"
      compact={slot !== "center"}
      api={api}
      navigate={navigate}
    />
  );
}
