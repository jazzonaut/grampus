// Polling for server views. Small on purpose: one request at a time, paused while hidden.
import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, toValue, watch } from 'vue';
import type { ComputedRef, MaybeRefOrGetter } from 'vue';
import { ApiError } from './client';

export interface PolledOptions {
  /** Polling runs only while this is true, e.g. `() => !needsAccessLink.value`. Default true. */
  readonly enabled?: MaybeRefOrGetter<boolean>;
}

export interface Polled<T> {
  /** The latest successful response, kept while later requests fail. */
  readonly data: ComputedRef<T | undefined>;
  /** The latest failure, cleared by the next success. */
  readonly error: ComputedRef<ApiError | undefined>;
  /** True while a request is in flight. */
  readonly loading: ComputedRef<boolean>;
  /** Fetch now (e.g. after an action). Joins the request in flight instead of overlapping it. */
  refresh(): Promise<void>;
  /** Stop polling for good. Also happens when the owning component unmounts. */
  stop(): void;
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  return new ApiError(0, error instanceof Error ? error.message : String(error));
}

/**
 * Calls `fetcher` now and then every `intervalMs` after the previous call settles.
 *
 * - Requests never overlap: the next one is scheduled only when the last has finished, and
 *   `refresh()` while one is in flight waits for it rather than starting another.
 * - While the tab is hidden nothing is scheduled; becoming visible fetches immediately.
 * - A refresh never starts provider calls, checks or Git writes on the server; it only reads.
 */
export function usePolled<T>(
  fetcher: () => Promise<T>,
  intervalMs: MaybeRefOrGetter<number>,
  options: PolledOptions = {},
): Polled<T> {
  const data = shallowRef<T>();
  const error = shallowRef<ApiError>();
  const loading = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;
  let stopped = false;

  const active = (): boolean => !stopped && document.visibilityState !== 'hidden' && toValue(options.enabled ?? true);

  const clear = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    clear();
    if (active())
      timer = setTimeout(() => {
        void refresh();
      }, toValue(intervalMs));
  };

  async function run(): Promise<void> {
    loading.value = true;
    try {
      data.value = await fetcher();
      error.value = undefined;
    } catch (caught) {
      error.value = asApiError(caught);
    } finally {
      loading.value = false;
    }
  }

  function refresh(): Promise<void> {
    if (inFlight) return inFlight;
    if (stopped) return Promise.resolve();
    clear();
    inFlight = run().finally(() => {
      inFlight = undefined;
      schedule();
    });
    return inFlight;
  }

  const onVisibility = (): void => {
    if (active()) void refresh();
    else clear();
  };

  document.addEventListener('visibilitychange', onVisibility);
  const stopWatch = watch(
    () => toValue(options.enabled ?? true),
    enabled => {
      if (enabled) void refresh();
      else clear();
    },
  );

  function stop(): void {
    stopped = true;
    clear();
    document.removeEventListener('visibilitychange', onVisibility);
    stopWatch();
  }
  if (getCurrentScope()) onScopeDispose(stop);
  if (active()) void refresh();

  return {
    data: computed(() => data.value),
    error: computed(() => error.value),
    loading: computed(() => loading.value),
    refresh,
    stop,
  };
}
