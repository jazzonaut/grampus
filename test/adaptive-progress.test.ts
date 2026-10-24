// Losing review evidence must not look like progress merely because fewer reasons were recorded.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseReviewReport } from '../src/domain/review.js';
import { DriverCore } from '../src/pipeline/driver-core.js';
import { selectedRepairAssignment } from '../src/pipeline/delivery.js';
import { pipelineRecipe } from './helpers/recipe-fixture.js';
import { createHarness, goodWorkers, reviewJson } from './helpers/task-fixture.js';

for (const evidence of ['missing', 'unknown', 'stale', 'valid'] as const) {
  test(`adaptive progress uses comparable review evidence: ${evidence}`, async () => {
    const fallback = { agent: 'codex' as const, model: 'stronger' };
    const h = await createHarness(h => goodWorkers(h), {
      ...pipelineRecipe,
      repair: { ...pipelineRecipe.repair, fallback, stagnantRounds: 2 },
    });
    const core = new DriverCore(h.store, h.orca, () => {});
    for (const round of [0, 1]) {
      core.record({
        type: 'round.decided',
        round,
        sha: `candidate-${round}`,
        specVersion: 1,
        decision: 'escalate',
        reasons: round === 0 ? ['coverage gap', 'unresolved concern', 'missing regression'] : ['review unavailable'],
      });
      core.record({
        type: 'review.recorded',
        round,
        attempt: 0,
        specVersion: 1,
        sha: round === 1 && evidence === 'stale' ? 'another-commit' : `candidate-${round}`,
        report:
          round === 1 && evidence === 'missing'
            ? null
            : parseReviewReport(reviewJson(round === 1 && evidence === 'unknown' ? 'unknown' : 'changes')),
        blocking: [],
        downgraded: [],
        error: round === 1 && evidence === 'missing' ? 'Report unavailable' : null,
      });
    }
    assert.deepEqual(selectedRepairAssignment(core, 2), evidence === 'valid' ? pipelineRecipe.build : fallback);
  });
}
