// Owns the mapping from each active guided stage to its handler. Typed as a complete record so a new
// stage cannot be added without a handler.
import type { ActiveStage } from '../state.js';
import type { StageHandler } from '../context.js';
import { workspaceStage } from './workspace.js';
import { executionStage, reviewExecutionStage } from './execution.js';
import { preparationStage } from './preparation.js';
import { scopeStage } from './scope.js';
import { implementationStage } from './implementation.js';
import { validationStage, verificationStage } from './checks.js';
import { submissionStage } from './submission.js';
import { assessmentStage } from './assessment.js';
import { reviewStage } from './review.js';
import { deliveryStage } from './delivery.js';

/** The handler for every stage that dispatches work, in workflow order. */
export const stageHandlers: Readonly<Record<ActiveStage, StageHandler>> = {
  workspace: workspaceStage,
  execution: executionStage,
  preparation: preparationStage,
  scope: scopeStage,
  implementation: implementationStage,
  refresh: preparationStage,
  validation: validationStage,
  submission: submissionStage,
  review_execution: reviewExecutionStage,
  review: reviewStage,
  assessment: assessmentStage,
  verification: verificationStage,
  delivery: deliveryStage,
};
