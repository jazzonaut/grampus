// Pins the evidence required for continued review repair, including reworded and lens blockers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blockingFindings, reviewProgress } from '../src/orchestration/guided/repair-policy.js';
import { parseReply, type Reply } from '../src/providers/types.js';
import { guidedRecord } from './helpers/task-records.js';
import { lens, review } from './helpers/guided-tasks.js';
import { builtInQualityPasses } from '../src/domain/quality-passes.js';

const prior = [{ id: 'review:0', description: 'Spacing defect', evidence: 'Wrong advance' }];
const related = [{ id: 'next:0', description: 'Preserved whitespace defect', evidence: 'Different advance' }];
const resolved: Reply = {
  ...review,
  priorFindings: [{ id: 'review:0', status: 'resolved', evidence: 'Checked corrected spacing' }],
};

test('a new related defect is progress only after complete evidenced resolution of prior blockers', () => {
  assert.equal(reviewProgress([], related, review), 'progress');
  assert.equal(reviewProgress(prior, related, resolved), 'progress');
  assert.equal(reviewProgress(prior, [], resolved), 'progress');
  assert.equal(reviewProgress(prior, related, review), 'unknown');
  for (const claims of [
    [{ id: 'foreign', status: 'resolved', evidence: 'Checked' }],
    [resolved.priorFindings![0]!, resolved.priorFindings![0]!],
  ] as NonNullable<Reply['priorFindings']>[])
    assert.equal(reviewProgress(prior, related, { ...review, priorFindings: claims }), 'unknown');
});

test('a continuing blocker stops despite changed bytes or a reviewer claiming it resolved', () => {
  assert.equal(
    reviewProgress(prior, related, {
      ...resolved,
      priorFindings: [{ id: 'review:0', status: 'unresolved', evidence: 'Defect persists with different wording' }],
    }),
    'stalled',
  );
  assert.equal(reviewProgress(prior, [{ ...related[0]!, description: '  SPACING   defect ' }], resolved), 'stalled');
});

test('failed selected lenses receive stable blocker identities even without a finding list', () => {
  const state = guidedRecord();
  state.plan.quality.passes = builtInQualityPasses.filter(pass => pass.id === 'simplification');
  const findings = blockingFindings(state, { ...review, lenses: [lens('fail', 'Remove the wrapper')] }, 'verdict');
  assert.deepEqual(findings, [
    { id: 'verdict:0', description: 'Remove the wrapper', evidence: 'Failed quality lens: simplification' },
  ]);
  assert.deepEqual(
    blockingFindings(state, { ...review, lenses: [lens('fail', 'Not selected', 'naming')] }, 'verdict'),
    [],
  );
});

test('resolution claims require nonempty evidence and are restricted to review replies', () => {
  assert.throws(() =>
    parseReply({ ...resolved, priorFindings: [{ id: 'review:0', status: 'resolved', evidence: ' ' }] }),
  );
  assert.throws(() => parseReply({ ...resolved, kind: 'message' }));
});
