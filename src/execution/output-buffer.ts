// Owns coalescing of a provider run's streamed text. Every `output.delta` used to be its own journal
// transaction; the buffer holds text in memory and journals it as one event at most every
// `outputFlushIntervalMs` or `outputFlushBytes`, and always before any other event of the run, so the
// journal order of output and everything else is unchanged. Streamed text is display-only: a crash
// loses at most the text of one interval, never evidence, a result or usage.
import { z } from 'zod';
import { currentSettings } from '../config/settings.js';
import type { AgentEvent } from '../providers/types.js';

const deltaSchema = z.object({ text: z.string() });

/** The text of a provider `output.delta` event, or null for any other event. */
export function deltaText(event: AgentEvent): string | null {
  if (event.type !== 'output.delta') return null;
  return deltaSchema.safeParse(event.data).data?.text ?? null;
}

/**
 * Buffers one run's streamed text. `write` journals coalesced text and may throw (for example when
 * the run lost ownership); a failure during a timed flush is rethrown by the next `add` or `flush`,
 * so the run's own event path still sees it.
 */
export class OutputBuffer {
  private pending: string[] = [];
  private bytes = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private failure: Error | null = null;
  private readonly interval: number;
  private readonly limit: number;

  constructor(private readonly write: (text: string) => void) {
    const settings = currentSettings();
    this.interval = settings.outputFlushIntervalMs;
    this.limit = settings.outputFlushBytes;
  }

  /** Adds streamed text; journals now when the buffer reaches the size limit, otherwise within the interval. */
  add(text: string): void {
    this.rethrow();
    if (!text) return;
    this.pending.push(text);
    this.bytes += Buffer.byteLength(text);
    if (this.bytes >= this.limit) this.flush();
    else if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        try {
          this.flush();
        } catch (error) {
          this.failure = error instanceof Error ? error : new Error('Streamed output could not be journaled');
        }
      }, this.interval);
      this.timer.unref();
    }
  }

  /** Journals any buffered text as one event. Call before every other event of the run and at settlement. */
  flush(): void {
    this.rethrow();
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.length) return;
    const text = this.pending.join('');
    this.pending = [];
    this.bytes = 0;
    this.write(text);
  }

  private rethrow(): void {
    if (this.failure === null) return;
    const failure = this.failure;
    this.failure = null;
    throw failure;
  }
}
