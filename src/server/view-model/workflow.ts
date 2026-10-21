// Owns the workflow strip: the ordered stages of the current slice (plan, implement, each selected edit
// assigned quality pass, validate, accept, review with one item per selected lens, deliver), each with its state
// and who established it. Stages come from the approved plan, so configurable passes appear as data.
import type { Evidence } from '../../domain/workflow.js';
import type { GuidedPlan } from '../../domain/guided-plan.js';
import type { LensAssessment } from '../../domain/quality-passes.js';
import { selectedEditPasses, selectedLenses } from '../../domain/quality-passes.js';
import type { QualityEditRecord, Stage } from '../../orchestration/guided/state.js';
import type { EvidenceSource, PresentationStatus, StageItemView, StageState, StageView } from '../api-types.js';

/** What the strip is computed from. */
export interface WorkflowFacts {
  plan: GuidedPlan;
  stage: Stage;
  /** The task's presentation status; decides how the current stage is drawn. */
  status: PresentationStatus;
  version: number;
  approved: boolean;
  sliceIndex: number;
  /** Edit passes applied in the current slice. */
  qualityEdits: readonly QualityEditRecord[];
  /** Recorded evidence of the current attempt (requested placeholders excluded). */
  evidence: readonly Evidence[];
  /** The reviewer's lens verdicts on display. */
  lenses: readonly LensAssessment[];
  /** Implementation attempts after the first in this slice (check and review repairs). */
  repairs: number;
}

/** Who established a recorded piece of evidence. Quality evidence without a reviewer is your own assessment. */
export function evidenceSource(evidence: Pick<Evidence, 'kind' | 'source'>): EvidenceSource {
  if (evidence.source === 'controller') return evidence.kind === 'quality' ? 'human-assessed' : 'controller-verified';
  return 'agent-reported';
}

function latest(evidence: readonly Evidence[], kind: Evidence['kind'], pass?: string): Evidence | null {
  return evidence.findLast(item => item.kind === kind && (pass === undefined || item.pass === pass)) ?? null;
}

/** Refresh belongs before readiness when checks are declared, otherwise before behavioural validation. */
function readinessPosition(ids: readonly string[]): number {
  return ids.indexOf(ids.includes('readiness') ? 'readiness' : 'validate');
}

/** Supervised quality input precedes acceptance; reviewer assessments follow acceptance. */
function assessmentPosition(facts: WorkflowFacts, ids: readonly string[]): number {
  return ids.indexOf(facts.plan.workflowPolicy.mode === 'supervised' ? 'assessment' : 'review');
}

/** The strip position of an internal stage; `complete` is past every stage. */
function position(facts: WorkflowFacts, ids: readonly string[]): number {
  const index = (id: string) => ids.indexOf(id);
  if (!facts.approved && facts.stage !== 'complete') return index('plan');
  switch (facts.stage) {
    case 'workspace':
    case 'execution':
    case 'preparation':
    case 'scope':
    case 'implementation':
      return index('implement');
    case 'quality_pass': {
      const next = selectedEditPasses(facts.plan.quality).find(
        pass =>
          !!facts.plan.modelProfile?.qualityPasses?.[pass.id] &&
          !facts.qualityEdits.some(edit => edit.pass === pass.id),
      );
      return next ? index(`quality:${next.id}`) : index('validate');
    }
    case 'refresh':
      return readinessPosition(ids);
    case 'readiness':
      return index('readiness');
    case 'validation':
    case 'submission':
      return index('validate');
    case 'assessment':
      return assessmentPosition(facts, ids);
    case 'review_execution':
    case 'review':
      return index('review');
    case 'verification':
      return index('accept');
    case 'delivery':
      return index('deliver');
    case 'complete':
      return ids.length;
  }
}

/** How the stage the task is at is drawn, from the task's presentation status. */
function currentState(status: PresentationStatus): { state: StageState; detail: string | null } {
  switch (status) {
    case 'working':
      return { state: 'active', detail: null };
    case 'stopping':
      return { state: 'active', detail: 'Stopping' };
    case 'awaiting_human':
      return { state: 'active', detail: 'Waiting for you' };
    case 'failed':
      return { state: 'failed', detail: null };
    case 'blocked':
    case 'unknown':
      return { state: 'unknown', detail: 'Stopped before a result' };
    case 'idle':
      return { state: 'pending', detail: 'Ready to continue' };
    case 'verified':
    case 'complete':
      return { state: 'passed', detail: null };
  }
}

function lensItems(facts: WorkflowFacts, reached: boolean): StageItemView[] {
  return selectedLenses(facts.plan.quality).map(lens => {
    const recorded = latest(facts.evidence, 'quality', lens.id);
    const verdict = facts.lenses.find(item => item.lens === lens.id);
    const state: StageState = recorded
      ? recorded.outcome === 'passed'
        ? 'passed'
        : recorded.outcome === 'skipped'
          ? 'skipped'
          : 'failed'
      : verdict
        ? verdict.verdict === 'pass'
          ? 'pending'
          : 'failed'
        : 'pending';
    return {
      id: `lens:${lens.id}`,
      label: lens.title,
      state: reached || recorded ? state : 'pending',
      evidence: recorded ? evidenceSource(recorded) : verdict ? 'agent-reported' : null,
      detail: recorded
        ? recorded.source === 'agent'
          ? 'Assessed by the independent reviewer'
          : 'Your assessment'
        : verdict
          ? `Reviewer verdict: ${verdict.verdict}`
          : null,
    };
  });
}

interface StageSpec {
  id: string;
  kind: StageView['kind'];
  label: string;
  /** Evidence and detail once the stage has passed. */
  passed: { evidence: EvidenceSource | null; detail: string | null };
}

function stageSpecs(facts: WorkflowFacts): StageSpec[] {
  const slice = facts.plan.slices[facts.sliceIndex];
  const validation = latest(facts.evidence, 'validation');
  const sliceCount = facts.plan.slices.length;
  return [
    {
      id: 'plan',
      kind: 'plan',
      label: 'Plan',
      passed: { evidence: null, detail: `Version ${facts.version} approved` },
    },
    {
      id: 'implement',
      kind: 'implement',
      label: 'Implement',
      passed: {
        evidence: 'agent-reported',
        detail: facts.repairs ? `${facts.repairs} ${facts.repairs === 1 ? 'repair' : 'repairs'}` : null,
      },
    },
    ...selectedEditPasses(facts.plan.quality)
      .filter(pass => facts.plan.modelProfile?.qualityPasses?.[pass.id])
      .map((pass): StageSpec => ({
        id: `quality:${pass.id}`,
        kind: 'quality_pass',
        label: pass.title,
        passed: { evidence: 'agent-reported', detail: 'Explicitly assigned edit quality pass' },
      })),
    ...(slice?.readiness.length
      ? [
          {
            id: 'readiness',
            kind: 'readiness' as const,
            label: 'Readiness',
            passed: {
              evidence: 'controller-verified' as const,
              detail: slice.readiness.map(check => check.name).join(', '),
            },
          },
        ]
      : []),
    {
      id: 'validate',
      kind: 'validate',
      label: 'Validate',
      passed: {
        evidence: validation ? evidenceSource(validation) : 'controller-verified',
        detail: slice?.validation.name ?? null,
      },
    },
    ...(facts.plan.workflowPolicy.mode === 'supervised' && selectedLenses(facts.plan.quality).length
      ? [
          {
            id: 'assessment',
            kind: 'quality_pass' as const,
            label: 'Quality assessment',
            passed: { evidence: 'human-assessed' as const, detail: 'Your recorded quality assessment' },
          },
        ]
      : []),
    {
      id: 'accept',
      kind: 'accept',
      label: 'Accept',
      passed: {
        evidence: 'controller-verified',
        detail: slice?.acceptance.map(check => check.name).join(', ') ?? null,
      },
    },
    {
      id: 'review',
      kind: 'review',
      label: 'Review',
      passed: { evidence: 'agent-reported', detail: 'Independent review of the verified candidate' },
    },
    {
      id: 'deliver',
      kind: 'deliver',
      label: 'Deliver',
      passed: {
        evidence: 'controller-verified',
        detail: sliceCount > 1 ? `Slice ${facts.sliceIndex + 1} of ${sliceCount}` : 'Verified local commit',
      },
    },
  ];
}

/** The ordered stages of the current slice with their states. */
export function workflowStages(facts: WorkflowFacts): StageView[] {
  const specs = stageSpecs(facts);
  const current = position(
    facts,
    specs.map(spec => spec.id),
  );
  return specs.map((spec, index): StageView => {
    const passed = index < current;
    const here = index === current;
    const look = here ? currentState(facts.status) : null;
    const state: StageState = passed
      ? spec.kind === 'quality_pass' && !spec.passed.evidence
        ? 'unknown'
        : 'passed'
      : (look?.state ?? 'pending');
    const items = spec.kind === 'review' ? lensItems(facts, passed || here) : [];
    return {
      id: spec.id,
      kind: spec.kind,
      label: spec.label,
      state,
      evidence: passed ? spec.passed.evidence : null,
      detail: passed ? spec.passed.detail : (look?.detail ?? null),
      items,
    };
  });
}
