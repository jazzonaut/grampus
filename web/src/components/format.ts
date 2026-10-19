// Number, time and text formatting for display. A missing measurement is "Unknown", never 0.

const tokens = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const dollars = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const dateTime = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'medium' });

/** Text shown for a value that was not measured. */
export const unknownText = 'Unknown';

/** A token count, or "Unknown" for null. */
export function formatTokens(value: number | null): string {
  return value === null ? unknownText : tokens.format(value);
}

/** An estimated US dollar amount, or "Unknown" for null. */
export function formatUsd(value: number | null): string {
  return value === null ? unknownText : dollars.format(value);
}

/** A whole count with thousands separators. */
export function formatCount(value: number): string {
  return tokens.format(value);
}

/** A duration such as "45s", "3m 12s" or "2h 5m". */
export function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Time since an ISO timestamp, e.g. "3m 12s"; empty for null or an unreadable time. */
export function elapsedSince(iso: string | null, now: number): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  return Number.isNaN(at) ? '' : formatDuration(now - at);
}

/** A local date and time, e.g. "19 Oct 2026, 09:00:00"; empty for null. */
export function localTime(iso: string | null): string {
  if (!iso) return '';
  const at = Date.parse(iso);
  return Number.isNaN(at) ? iso : dateTime.format(at);
}

/** Whole minutes since an ISO time, for "No activity for N min". */
export function minutesSince(iso: string, now: number): number {
  return Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
}

/** A command timeout in seconds, e.g. "120 s". */
export function formatTimeout(milliseconds: number): string {
  return `${formatCount(Math.round(milliseconds / 1000))} s`;
}

/** The first 12 characters of a commit or digest, which is how Git and the journal abbreviate them. */
export function short(digest: string): string {
  return digest.slice(0, 12);
}

/** "1 turn", "3 turns". */
export function plural(count: number, one: string, many = `${one}s`): string {
  return `${formatCount(count)} ${count === 1 ? one : many}`;
}
