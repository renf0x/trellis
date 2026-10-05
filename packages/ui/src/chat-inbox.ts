// Hand-off from any screen to a chat: a report, a finding or a selected fragment becomes an attachment
// the chat panel shows above its input and sends with the next question. Lives in memory for the tab.
// Reports go to the workbench chat with openInWorkChat (chat-store.ts): a tab per report.
import type { ChatChannel } from "@trellis/core";

export interface ChatAttachment {
  id: string;
  /** Short label for the chip, e.g. "#123 Вход в систему". */
  title: string;
  /** Full context the model gets: sources, verdict, explanation. */
  text: string;
  /** The fragment the user selected, if any; the question is about it. */
  quote?: string;
}

const pending: Record<ChatChannel, ChatAttachment[]> = { main: [], work: [], dev: [] };
const listeners = new Set<(bucket: ChatChannel) => void>();

export function sendToChat(bucket: ChatChannel, a: Omit<ChatAttachment, "id">) {
  pending[bucket] = [...pending[bucket], { ...a, id: crypto.randomUUID() }].slice(-8);
  for (const l of listeners) l(bucket);
}

export function takeAttachments(bucket: ChatChannel): ChatAttachment[] {
  const out = pending[bucket];
  pending[bucket] = [];
  return out;
}

export function onAttachments(fn: (bucket: ChatChannel) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** Text the model receives: attachments as delimited data blocks, then the question. */
export function composeMessage(attachments: ChatAttachment[], question: string) {
  if (!attachments.length) return question;
  const blocks = attachments.map((a, i) =>
    `<<<КОНТЕКСТ ${i + 1}: ${a.title}\n${a.text}${a.quote ? `\n\nВыделенный фрагмент:\n«${a.quote}»` : ""}\n>>>`);
  return `${blocks.join("\n\n")}\n\nВопрос: ${question}`;
}
