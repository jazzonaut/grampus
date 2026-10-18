// Number formatting for measurements. A missing measurement is "Unknown", never 0.

const tokens = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const dollars = new Intl.NumberFormat('en-GB', {
  style: 'currency',
  currency: 'USD',
  currencyDisplay: 'narrowSymbol',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

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
