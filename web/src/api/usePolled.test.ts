import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, ref } from 'vue';
import { usePolled } from './usePolled';

let visibility: DocumentVisibilityState = 'visible';

function setVisibility(next: DocumentVisibilityState): void {
  visibility = next;
  document.dispatchEvent(new Event('visibilitychange'));
}

/** A fetcher whose calls stay pending until resolved by the test. */
function deferredFetcher(): { fetcher: () => Promise<number>; calls: () => number; resolve: () => void } {
  const pending: ((value: number) => void)[] = [];
  let count = 0;
  return {
    fetcher: () =>
      new Promise<number>(resolve => {
        count += 1;
        pending.push(resolve);
      }),
    calls: () => count,
    resolve: () => pending.shift()?.(count),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('usePolled', () => {
  it('never overlaps requests', async () => {
    const scope = effectScope();
    const source = deferredFetcher();
    const polled = scope.run(() => usePolled(source.fetcher, 1000));

    expect(source.calls()).toBe(1);
    void polled?.refresh();
    await vi.advanceTimersByTimeAsync(5000);
    expect(source.calls()).toBe(1);

    source.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(polled?.data.value).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(source.calls()).toBe(2);
    scope.stop();
  });

  it('pauses while the tab is hidden and fetches on return', async () => {
    const scope = effectScope();
    const fetcher = vi.fn().mockResolvedValue('state');
    scope.run(() => usePolled(fetcher, 1000));
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    setVisibility('hidden');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    setVisibility('visible');
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    scope.stop();
  });

  it('waits while disabled and stops with its scope', async () => {
    const scope = effectScope();
    const enabled = ref(false);
    const fetcher = vi.fn().mockResolvedValue('state');
    scope.run(() => usePolled(fetcher, 1000, { enabled }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).not.toHaveBeenCalled();

    enabled.value = true;
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(1);

    scope.stop();
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
