// Screen reader announcements and the shared clock. AppShell reads `announcement` into its polite live
// region, so a status change on any screen ("Task now: Working") is spoken without moving focus.
import { getCurrentScope, onScopeDispose, readonly, ref } from 'vue';
import { clockTickMs } from './settings';

const message = ref('');

/** The latest announcement, for the live region. */
export const announcement = readonly(message);

/** Announces `text` politely. Repeating the same text announces it again. */
export function announce(text: string): void {
  // A live region only speaks a change, so clear it first when the text repeats.
  if (message.value === text) message.value = '';
  queueMicrotask(() => {
    message.value = text;
  });
}

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
let users = 0;

/** The current time, ticking once a second while any component uses it; for elapsed times. */
export function useNow(): Readonly<typeof now> {
  users += 1;
  timer ??= setInterval(() => {
    now.value = Date.now();
  }, clockTickMs);
  if (getCurrentScope())
    onScopeDispose(() => {
      users -= 1;
      if (users === 0 && timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    });
  return readonly(now);
}
