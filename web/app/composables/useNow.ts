// A shared clock for relative times ("4 min ago"), ticking often enough for minute precision.
import { ref } from 'vue';

const tickMs = 20_000;
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

export function useNow() {
  timer ??= setInterval(() => (now.value = Date.now()), tickMs);
  return now;
}
