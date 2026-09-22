
export function Offline({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid h-full place-items-center">
      <div className="max-w-md rounded-xl border border-line bg-panel p-6 text-center">
        <div className="text-lg font-semibold">Сервер Trellis недоступен</div>
        <p className="mt-2 text-dim">{message}</p>
        <p className="mt-2 text-xs text-faint">Запустите <code>npm run dev</code> в корне проекта.</p>
        <button onClick={onRetry} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm">Повторить</button>
      </div>
    </div>
  );
}
