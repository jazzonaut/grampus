// Recorded delivery authority and budgets. Policy actions never impersonate user commands.
import { deliveryLimits } from '../config/limits.js';
import { deliverySchema, type Assignment } from '../domain/recipe.js';
import type { TaskEvent } from '../domain/events.js';
import { estimateCost } from '../measure/cost.js';
import { measureDispatches } from '../measure/usage.js';
import { currentSettings } from '../config/settings.js';
import type { DriverCore } from './driver-core.js';

/** A budget stop is incomplete, never acceptance or an override. */
export class BudgetExhausted extends Error {}

/** Missing delivery configuration means the explicitly supervised workflow. */
export function deliveryPolicy(core: DriverCore) {
  return core.state.recipe.delivery ?? deliverySchema.parse({});
}

/** Record an idempotent action under the recipe mandate, with its evidence binding. */
export function policyDecision(
  core: DriverCore,
  decision: Omit<Extract<TaskEvent, { type: 'policy.decided' }>, 'type'>,
): void {
  if (core.events.some(event => event.type === 'policy.decided' && event.key === decision.key)) return;
  core.record({ type: 'policy.decided', ...decision });
}

/** Enforce wall time even during a worker wait. Human decisions do not extend the recorded mandate. */
export function checkDeadline(core: DriverCore): void {
  if (!core.state.recipe.delivery || core.state.finished) return;
  const elapsed = Date.now() - Date.parse(core.state.createdAt);
  if (elapsed >= deliveryPolicy(core).maxSeconds * deliveryLimits.millisecondsPerSecond)
    throw new BudgetExhausted(
      `Delivery time budget exhausted after ${Math.round(elapsed / deliveryLimits.millisecondsPerSecond)}s. Result remains incomplete; start a task with a larger mandate to continue.`,
    );
}

/** Abort child check processes when the task's recorded elapsed-time budget expires. */
export function deliverySignal(core: DriverCore): AbortSignal | undefined {
  if (!core.state.recipe.delivery) return undefined;
  checkDeadline(core);
  return AbortSignal.timeout(
    Math.max(
      1,
      Math.ceil(
        Date.parse(core.state.createdAt) +
          deliveryPolicy(core).maxSeconds * deliveryLimits.millisecondsPerSecond -
          Date.now(),
      ),
    ),
  );
}

/** Estimated spending is checked before dispatch. Missing prices or usage cannot authorise more spend. */
export async function checkDispatchBudget(core: DriverCore, key: string): Promise<void> {
  checkDeadline(core);
  const policy = core.state.recipe.delivery;
  if (!policy || policy.maxCostUsd === null) return;
  const measured = await measureDispatches(core.state, core.orca);
  const priced = measured.map(item => estimateCost(item, currentSettings().modelPrices).usd);
  const unknownCosts = priced.filter(value => value === null).length;
  const costUsd = unknownCosts ? null : priced.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const reason = unknownCosts
    ? 'Estimated cost is unknown for a prior dispatch; the spending mandate cannot authorise another worker.'
    : costUsd !== null && costUsd >= policy.maxCostUsd
      ? `Estimated cost budget reached ($${costUsd.toFixed(2)} of $${policy.maxCostUsd}).`
      : null;
  core.record({
    type: 'budget.checked',
    key,
    elapsedMs: Date.now() - Date.parse(core.state.createdAt),
    costUsd,
    unknownCosts,
    reason,
  });
  if (reason) throw new BudgetExhausted(reason);
}

/** Keep a cheaper editor while failure counts improve; switch once and retain the decision on restart. */
export function selectedRepairAssignment(core: DriverCore, round: number): Assignment {
  const { repair, build } = core.state.recipe;
  const normal = repair.assignment ?? build;
  if (!repair.fallback) return normal;
  if (core.events.some(event => event.type === 'policy.decided' && event.action === 'fallback')) return repair.fallback;
  const count = repair.stagnantRounds ?? deliveryLimits.stagnantRounds;
  if (round < count) return normal;
  const failures = Array.from({ length: count }, (_, index) => {
    const previous = round - count + index;
    return core.state.decisions.get(previous)?.reasons.length ?? 0;
  });
  if (
    failures.some(value => value === 0) ||
    failures.some((value, index) => index > 0 && value < (failures[index - 1] ?? 0))
  )
    return normal;
  policyDecision(core, {
    key: `fallback:${round}`,
    action: 'fallback',
    reason: `Unresolved failure count did not decrease across ${count} rounds; use the configured fallback within the same budget.`,
    sha: core.state.verify.get(round - 1)?.sha ?? null,
    specVersion: core.state.specs.at(-1)?.version ?? null,
  });
  return repair.fallback;
}

/** Shared worker instructions remove routine implementation questions without inventing product choices. */
export function mandatePrompt(core: DriverCore): string {
  if (deliveryPolicy(core).mode !== 'unattended') return '';
  return `\nDELIVERY MANDATE: Resolve implementation choices by inspecting the request and repository conventions. Record assumptions. Ask only for consequential product ambiguity or authority outside the request. Do not ask how to write a test, choose a helper, fix a check, or format your report. Batch concrete defects and use focused tests during repair, then run required verification. Do not weaken checks, expand scope, merge, push or deploy. Time budget: ${deliveryPolicy(core).maxSeconds}s from task creation, including recovery. Unknown remains unknown.\n`;
}
