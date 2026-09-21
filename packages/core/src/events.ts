// Minimal typed event bus shared by core and modules.

type Handler<T> = (payload: T) => void;

export class EventBus<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<Handler<never>>>();

  on<K extends keyof Events>(event: K, handler: Handler<Events[K]>): () => void {
    let set = this.handlers.get(event);
    if (!set) this.handlers.set(event, (set = new Set()));
    set.add(handler as Handler<never>);
    return () => set.delete(handler as Handler<never>);
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    for (const h of this.handlers.get(event) ?? []) {
      try {
        (h as Handler<Events[K]>)(payload);
      } catch (err) {
        // One broken module must not break the others.
        console.error(`[events] handler for ${String(event)} failed`, err);
      }
    }
  }
}
