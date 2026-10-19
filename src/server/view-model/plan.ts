// Owns how a guided plan is shown for approval and inspection: its outcome, slices, exact commands and
// the policy sentences (workflow, review repairs, quality passes) the dashboard prints beside them.
import type { GuidedPlan } from '../../domain/guided-plan.js';
import type { PlanSliceView, PlanView } from '../api-types.js';
import { folderName, providerLabel } from './status.js';

const command = (spec: { name: string; file: string; args: string[]; timeoutMs: number }) => ({
  name: spec.name,
  file: spec.file,
  args: [...spec.args],
  timeoutMs: spec.timeoutMs,
});

/** One paragraph on the workflow policy, as approval shows it. */
export function workflowSummary(plan: GuidedPlan): string {
  const policy = plan.workflowPolicy;
  const mode =
    policy.mode === 'automatic'
      ? `Automatic workflow: implement, validate, repair, independently review and deliver within the approved scope. Up to ${policy.repairRounds} shared ${policy.repairRounds === 1 ? 'repair' : 'repairs'} per slice across validation, review and acceptance.`
      : 'Supervised workflow: pause for file authorization and quality assessment.';
  return `${mode} Conversations resume within a slice and start fresh after ${policy.maxSessionTurns} turns or ${policy.maxContextTokens.toLocaleString('en-GB')} observed context tokens. Each slice and arbitration starts fresh.`;
}

/**
 * Review uses the shared allowance; continued blocking verdicts require evidence of progress.
 */
export function reviewSummary(plan: GuidedPlan): string {
  const arbitrator = plan.reviewPolicy?.arbitrator;
  return [
    'Review repairs use the shared slice allowance. Unchanged artifacts, unresolved blockers or missing progress evidence stop automatic repair.',
    arbitrator
      ? `Fresh arbitration: ${providerLabel(arbitrator.provider)}, model ${arbitrator.model ?? 'provider default'}.`
      : 'Unresolved findings stop for your decision.',
    plan.workflowPolicy.mode === 'automatic'
      ? 'Repairs continue within the approved scope with a fresh independent verdict.'
      : 'Each repair requires fresh file authorization and quality assessment.',
  ].join(' ');
}

/** One paragraph on the selected quality passes. */
export function qualitySummary(plan: GuidedPlan): string {
  if (!plan.quality.passes.length)
    return 'None selected. Independent review still checks the change; no quality assessment is recorded.';
  return `Lenses are assessed by the independent reviewer${plan.workflowPolicy.mode === 'supervised' ? ' and recorded from your quality assessment' : ''}. Edit passes run in this order once per slice, after the first successful implementation and before validation; repairs do not run them again.`;
}

function sliceView(plan: GuidedPlan, index: number): PlanSliceView {
  const slice = plan.slices[index];
  if (!slice) throw new Error(`Slice ${index + 1} is missing from the plan`);
  const brief = plan.brief.slices?.[index];
  return {
    title: brief?.title ?? plan.brief.title,
    approach: brief?.plan ?? null,
    criteria: brief ? [...brief.criteria] : [],
    files: {
      edit: [...slice.scope.files],
      create: [...(slice.scope.create ?? [])],
      delete: [...(slice.scope.delete ?? [])],
    },
    preparation: slice.preparation ? command(slice.preparation) : null,
    validation: command(slice.validation),
    acceptance: {
      ...command(slice.acceptance),
      expectedStdout: slice.acceptance.expectedStdout ?? null,
      expectations: slice.acceptance.expectations ? JSON.stringify(slice.acceptance.expectations, null, 2) : null,
    },
    delivery: { mode: slice.mode, message: slice.message },
  };
}

/** The plan as approval and inspection show it. */
export function planView(plan: GuidedPlan): PlanView {
  return {
    rawPlan: JSON.stringify(plan, null, 2),
    title: plan.brief.title,
    outcome: plan.brief.outcome,
    approach: plan.brief.plan,
    criteria: [...plan.brief.criteria],
    repository: { name: folderName(plan.workspace.repo), path: plan.workspace.repo },
    base: plan.workspace.base,
    workspace: { adapter: plan.workspace.adapter, path: plan.workspace.path ?? null },
    implementer: {
      id: plan.implementation.provider,
      label: providerLabel(plan.implementation.provider),
      model: plan.implementation.model,
    },
    reviewer: { id: plan.review.provider, label: providerLabel(plan.review.provider), model: plan.review.model },
    mode: plan.workflowPolicy.mode,
    workflowSummary: workflowSummary(plan),
    reviewSummary: reviewSummary(plan),
    qualityPasses: plan.quality.passes.map(pass => ({ ...pass })),
    qualitySummary: qualitySummary(plan),
    context: {
      files: [...plan.context.files],
      totalFiles: plan.context.totalFiles,
      exploration: plan.context.exploration,
    },
    preparation: plan.preparation ? command(plan.preparation) : null,
    revision: plan.revision
      ? { previousVersion: plan.revision.previousVersion, artifact: plan.revision.artifact }
      : null,
    slices: plan.slices.map((_, index) => sliceView(plan, index)),
  };
}
