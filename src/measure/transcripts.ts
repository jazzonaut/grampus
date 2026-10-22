// Reads model and token usage from provider transcripts on disk. Orca's own transcript view drops both,
// but its message ids name the provider session (`claude:<session>:...`, `codex:<session>:...`), and
// each provider keeps a JSONL transcript per session. Formats observed with Claude Code and Codex in
// October 2026; anything unrecognised yields unknown rather than zero.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const dayMs = 24 * 60 * 60 * 1000;

/** Tokens for one dispatch, normalised across providers: `input` excludes cache reads and writes. */
export interface Usage {
  /** Input tokens processed without the cache. */
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number | null;
}

export interface TranscriptWindow {
  /** Exclusive start: when the dispatch was requested. */
  from: number;
  /** Inclusive end: when the next dispatch in the same session was requested, or open. */
  to: number;
}

export interface TranscriptReading {
  models: string[];
  effort: string | null;
  usage: Usage | null;
}

/** The Claude transcript of a session, searched under each projects root. */
export function findClaudeTranscript(sessionId: string, roots: readonly string[]): string | null {
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = join(root, entry.name, `${sessionId}.jsonl`);
      if (existsSync(path)) return path;
    }
  }
  return null;
}

/** The Codex rollout of a session, searched in the date folders around `near`. */
export function findCodexTranscript(sessionId: string, roots: readonly string[], near: Date): string | null {
  const days = [-1, 0, 1].map(offset => new Date(near.getTime() + offset * dayMs));
  for (const root of roots)
    for (const day of days) {
      const dir = join(
        root,
        String(day.getFullYear()),
        String(day.getMonth() + 1).padStart(2, '0'),
        String(day.getDate()).padStart(2, '0'),
      );
      if (!existsSync(dir)) continue;
      const file = readdirSync(dir).find(name => name.endsWith(`-${sessionId}.jsonl`));
      if (file) return join(dir, file);
    }
  return null;
}

function lines(path: string): Record<string, unknown>[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim())
    .flatMap(line => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

function inWindow(timestamp: unknown, window: TranscriptWindow): boolean {
  if (typeof timestamp !== 'string') return false;
  const time = Date.parse(timestamp);
  return time > window.from && time <= window.to;
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Claude Code writes one line per content block, each repeating its message's usage, so usage is
 * counted once per message id.
 */
export function readClaudeTranscript(path: string, window: TranscriptWindow): TranscriptReading {
  const seen = new Set<string>();
  const models = new Set<string>();
  const usage: Usage = { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: null };
  let messages = 0;
  for (const line of lines(path)) {
    if (line['type'] !== 'assistant' || !inWindow(line['timestamp'], window)) continue;
    const message = line['message'] as Record<string, unknown> | undefined;
    const id = typeof message?.['id'] === 'string' ? message['id'] : null;
    if (!message || !id || seen.has(id)) continue;
    seen.add(id);
    if (typeof message['model'] === 'string' && message['model'] !== '<synthetic>') models.add(message['model']);
    const tokens = message['usage'] as Record<string, unknown> | undefined;
    if (!tokens) continue;
    messages++;
    usage.input += count(tokens['input_tokens']);
    usage.cachedInput += count(tokens['cache_read_input_tokens']);
    usage.cacheWrite += count(tokens['cache_creation_input_tokens']);
    usage.output += count(tokens['output_tokens']);
    const details = tokens['output_tokens_details'] as Record<string, unknown> | undefined;
    if (typeof details?.['thinking_tokens'] === 'number')
      usage.reasoning = (usage.reasoning ?? 0) + details['thinking_tokens'];
  }
  return { models: [...models], effort: null, usage: messages ? usage : null };
}

/** Codex reports cumulative session totals; a dispatch's usage is the growth of the total in its window. */
export function readCodexTranscript(path: string, window: TranscriptWindow): TranscriptReading {
  const models = new Set<string>();
  let effort: string | null = null;
  let before: Record<string, unknown> | null = null;
  let last: Record<string, unknown> | null = null;
  for (const line of lines(path)) {
    const payload = line['payload'] as Record<string, unknown> | undefined;
    if (!payload) continue;
    const timestamp = line['timestamp'];
    if (line['type'] === 'turn_context' && inWindow(timestamp, window)) {
      if (typeof payload['model'] === 'string') models.add(payload['model']);
      const level = payload['effort'] ?? payload['reasoning_effort'];
      if (typeof level === 'string') effort = level;
    }
    if (payload['type'] !== 'token_count') continue;
    const total = (payload['info'] as Record<string, unknown> | null | undefined)?.['total_token_usage'];
    if (!total || typeof total !== 'object') continue;
    if (typeof timestamp === 'string' && Date.parse(timestamp) <= window.from)
      before = total as Record<string, unknown>;
    else if (inWindow(timestamp, window)) last = total as Record<string, unknown>;
  }
  if (!last) return { models: [...models], effort, usage: null };
  const delta = (key: string) => count(last[key]) - count(before?.[key]);
  return {
    models: [...models],
    effort,
    usage: {
      // Codex counts cache reads inside input_tokens; Claude reports them separately.
      input: delta('input_tokens') - delta('cached_input_tokens'),
      cachedInput: delta('cached_input_tokens'),
      cacheWrite: delta('cache_write_input_tokens'),
      output: delta('output_tokens'),
      reasoning: delta('reasoning_output_tokens'),
    },
  };
}
