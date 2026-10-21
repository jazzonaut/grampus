// Pins approval of workspace execution without predicting implementation filenames.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeGuidedPlan } from '../src/domain/guided-plan.js';
import { fixture } from './helpers/guided-tasks.js';

test('a plan can approve workspace execution without an exact file list', t => {
  const f = fixture(t);
  const { scope: _scope, ...slice } = f.plan.slices[0]!;
  const plan = normalizeGuidedPlan({ ...f.plan, workflowPolicy: { mode: 'automatic' }, slices: [slice] });
  assert.deepEqual(plan.slices[0]!.scope, { files: [] });
  assert.equal(plan.workflowPolicy.mode, 'automatic');
});

test('suggested file actions do not freeze filenames or simulate future file existence', t => {
  const f = fixture(t);
  const scope = { files: ['helper-to-discover.ts'], create: ['greeting.js'] };
  const plan = normalizeGuidedPlan({ ...f.plan, slices: [{ ...f.plan.slices[0], scope }] });
  assert.deepEqual(plan.slices[0]!.scope, scope);
  assert.equal(plan.execution, 'adaptive');
});
