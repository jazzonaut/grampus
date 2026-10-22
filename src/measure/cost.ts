// Estimated cost of a dispatch at API list prices. Subscription use is not billed per token, so this is a
// common yardstick for comparing recipes, not a bill. Prices change: the built-in table is dated and
// `modelPrices` in config.json overrides it per model. A model without a price, or usage that cannot be
// split between models, stays unknown; it never counts as free.
import type { Usage } from './transcripts.js';

/** US dollars per million tokens. Reasoning tokens are billed as output and are already inside `output`. */
export interface ModelPrice {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
}

/**
 * Published standard-tier list prices, read on 2026-10-22: Anthropic's model table (cached 2026-10-06;
 * cache writes at the 5-minute rate of 1.25 times input) and https://developers.openai.com/api/docs/pricing
 * (up to 272K input tokens; OpenAI does not charge cache writes; GPT-5.6 Sol is a promotional price).
 */
export const defaultModelPrices: Readonly<Record<string, ModelPrice>> = {
  'claude-fable-5-1': { input: 10, cachedInput: 0.25, cacheWrite: 12.5, output: 50 },
  'claude-opus-5-5': { input: 4, cachedInput: 0.2, cacheWrite: 5, output: 20 },
  'claude-sonnet-5-5': { input: 2, cachedInput: 0.2, cacheWrite: 2.5, output: 10 },
  'claude-haiku-5-5': { input: 0.1, cachedInput: 0.01, cacheWrite: 0.125, output: 0.5 },
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, cacheWrite: 0, output: 10 },
  'gpt-6-astra': { input: 10, cachedInput: 1, cacheWrite: 0, output: 50 },
  'gpt-6-sol': { input: 2, cachedInput: 0.2, cacheWrite: 0, output: 10 },
  'gpt-6-luna': { input: 0.1, cachedInput: 0.01, cacheWrite: 0, output: 0.5 },
  'gpt-5.6-sol': { input: 4, cachedInput: 0.4, cacheWrite: 0, output: 20 },
  'gpt-5.6-terra': { input: 2, cachedInput: 0.2, cacheWrite: 0, output: 12 },
  'gpt-5.6-luna': { input: 0.2, cachedInput: 0.02, cacheWrite: 0, output: 1.2 },
};

const perMillion = 1_000_000;

export function costOf(usage: Usage, price: ModelPrice): number {
  return (
    (usage.input * price.input +
      usage.cachedInput * price.cachedInput +
      usage.cacheWrite * price.cacheWrite +
      usage.output * price.output) /
    perMillion
  );
}

/** What a dispatch's measurement says about its tokens, for pricing. */
export interface PricedUsage {
  models: readonly string[];
  usage: Usage | null;
  /** Usage per model, when the transcript names the model of every turn. */
  usageByModel?: Readonly<Record<string, Usage>> | null;
}

/** The estimated cost in US dollars, or null with the reason it is unknown. */
export function estimateCost(
  item: PricedUsage,
  prices: Readonly<Record<string, ModelPrice>>,
): { usd: number | null; note: string | null } {
  const byModel =
    item.usageByModel ?? (item.usage && item.models.length === 1 ? { [item.models[0] ?? '']: item.usage } : null);
  if (!byModel) return { usd: null, note: item.usage ? 'usage cannot be split between models' : 'usage unknown' };
  let usd = 0;
  for (const [model, usage] of Object.entries(byModel)) {
    const price = prices[model];
    if (!price) return { usd: null, note: `no price for ${model}; add it to modelPrices` };
    usd += costOf(usage, price);
  }
  return { usd, note: null };
}
