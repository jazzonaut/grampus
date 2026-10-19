// Owns the one byte budget every provider turn prompt shares (`promptLimits.turnBytes`). Builders charge
// the text a turn must carry first, then offer deferrable content in priority order, so a prompt is
// either within every provider's input limit or refused before any provider starts.
import { formatBytes, promptLimits } from '../config/limits.js';

const turnBudget = formatBytes(promptLimits.turnBytes);

/** A turn prompt that cannot fit the budget. Raised before dispatch, so no provider turn was spent. */
export class PromptBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptBudgetError';
  }
}

/** UTF-8 bytes of `text`, the unit of the budget. */
export const promptBytes = (text: string) => Buffer.byteLength(text);

/**
 * The bytes still available to one turn prompt. Callers charge whole serialised pieces, so the sum of
 * charges bounds the final prompt; {@link requirePromptBudget} checks the assembled text again.
 */
export class PromptBudget {
  private used = 0;

  /** Bytes still available. */
  get remaining(): number {
    return promptLimits.turnBytes - this.used;
  }

  /**
   * Charges text the turn cannot do without.
   *
   * @throws PromptBudgetError naming `what` when it does not fit, with `remedy` as the next step.
   */
  require(bytes: number, what: string, remedy: string): void {
    if (bytes > this.remaining)
      throw new PromptBudgetError(
        `${what} needs ${bytes} bytes but only ${Math.max(this.remaining, 0)} of the ${turnBudget} turn prompt budget remain; ${remedy}`,
      );
    this.used += bytes;
  }

  /** Charges deferrable content when it fits, reporting whether it did. */
  offer(bytes: number): boolean {
    if (bytes > this.remaining) return false;
    this.used += bytes;
    return true;
  }
}

/**
 * The final check on an assembled prompt, made before a provider is connected. Builders keep within the
 * budget by construction; this guards the invariant rather than deciding anything.
 *
 * @throws PromptBudgetError when the prompt exceeds `promptLimits.turnBytes`.
 */
export function requirePromptBudget(prompt: string): void {
  const bytes = promptBytes(prompt);
  if (bytes > promptLimits.turnBytes)
    throw new PromptBudgetError(
      `The turn prompt is ${bytes} bytes, over the ${turnBudget} turn prompt budget; nothing was sent to the provider`,
    );
}
