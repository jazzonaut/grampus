// One shared server-sent event stream. Listeners hear the ids of tasks whose logs changed; after a
// reconnect they hear `null`, meaning "anything may have changed, reload".
import { ref } from 'vue';
import type { LiveChange } from '../../../src/dashboard/types';

type Listener = (tasks: string[] | null) => void;

const connected = ref(false);
const listeners = new Set<Listener>();
let source: EventSource | null = null;

function open(): void {
  if (source) return;
  source = new EventSource('/api/live');
  source.addEventListener('hello', () => {
    const missed = !connected.value;
    connected.value = true;
    if (missed) for (const listener of listeners) listener(null);
  });
  source.addEventListener('change', event => {
    const change = JSON.parse((event as MessageEvent<string>).data) as LiveChange;
    for (const listener of listeners) listener(change.tasks);
  });
  // EventSource reconnects by itself; `hello` on reconnect triggers a full reload.
  source.addEventListener('error', () => {
    connected.value = false;
  });
}

/** Whether the live stream is connected, and a way to hear about changes. */
export function useLive() {
  open();
  return {
    connected,
    /** Listen for changes; returns a function that stops listening. */
    onChange(listener: Listener): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
