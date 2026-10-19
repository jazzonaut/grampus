// Quality pass tests: resolving a plan's selection to full definitions, its bounds, the reviewer's
// lens assessments and the gate each selected lens adds. No Git, providers or journal needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableQualityPasses,
  builtInQualityPasses,
  normalizeQuality,
  parseLensAssessments,
  parseQualityAssessment,
  type QualityPassDefinition,
} from '../src/domain/quality-passes.js';
import { requiredQualityLenses, type Task } from '../src/domain/workflow.js';
import { parseReply } from '../src/providers/types.js';
import { reviewPrompt, qualityPassPrompt } from '../src/orchestration/guided/prompts.js';
import { planningQualityInstructions } from '../src/orchestration/prompts/planning-quality.js';

const custom: QualityPassDefinition = {
  id: 'error-handling',
  title: 'Error handling',
  kind: 'lens',
  instructions: 'Assess whether every new failure path is reported with enough context to act on.',
};
const available = availableQualityPasses([custom]);

test('the built-ins are simplification and naming lenses and refactor and documentation edit passes', () => {
  assert.deepEqual(
    builtInQualityPasses.map(pass => [pass.id, pass.kind]),
    [
      ['simplification', 'lens'],
      ['naming', 'lens'],
      ['refactor', 'edit'],
      ['documentation', 'edit'],
    ],
  );
  assert.throws(() => {
    (builtInQualityPasses[0] as { instructions: string }).instructions = 'weakened';
  }, TypeError);
});

test('a plan selection resolves ids to full definitions, so the approval binds the exact instructions', () => {
  const quality = normalizeQuality({ passes: ['naming', 'error-handling', 'refactor'] }, available, []);
  assert.deepEqual(
    quality.passes.map(pass => pass.id),
    ['naming', 'error-handling', 'refactor'],
  );
  assert.deepEqual(quality.passes[1], custom);
  assert.equal(quality.passes[0]!.instructions, builtInQualityPasses[1]!.instructions);
  // Omitted quality takes the configured default; an empty list selects no passes at all.
  assert.deepEqual(
    normalizeQuality(undefined, available, ['simplification']).passes.map(pass => pass.id),
    ['simplification'],
  );
  assert.deepEqual(normalizeQuality({ passes: [] }, available, ['simplification']), { passes: [] });
  // A full definition is kept as given, even for an id the installation no longer defines.
  const retained = { ...custom, id: 'retired-lens', instructions: 'Instructions approved earlier.' };
  assert.deepEqual(normalizeQuality({ passes: [retained] }, available, []).passes, [retained]);
});

test('a plan selection refuses unknown, repeated, malformed and oversized passes', () => {
  const cases: [unknown, RegExp][] = [
    [{ passes: ['security'] }, /Unknown quality pass "security"; available: simplification, naming/],
    [{ passes: ['naming', 'naming'] }, /"naming" is selected more than once/],
    [{ passes: ['naming', { ...builtInQualityPasses[1] }] }, /"naming" is selected more than once/],
    [{ passes: Array.from({ length: 7 }, (_, index) => ({ ...custom, id: `lens-${index}` })) }, /at most 6/],
    [{ passes: [{ ...custom, instructions: 'x'.repeat(4097) }] }, /at most 4096 bytes/],
    [{ passes: [{ ...custom, id: 'Error_Handling' }] }, /kebab-case/],
    [{ passes: [{ ...custom, kind: 'fix' }] }, /kind/],
    [{ passes: [{ ...custom, owner: 'me' }] }, /Invalid quality pass definition/],
    [{ passes: 'naming' }, /Invalid quality/],
    [{ lenses: ['naming'] }, /Invalid quality/],
  ];
  for (const [input, message] of cases) assert.throws(() => normalizeQuality(input, available, []), message);
});

test('lens assessments are validated as part of a review reply only', () => {
  const lens = { lens: 'naming', verdict: 'fail', summary: 'Rename data', findings: [] };
  const review = { kind: 'review', text: 'Reviewed', questions: [], findings: [] };
  assert.deepEqual(parseReply({ ...review, lenses: [lens] }).lenses, [lens]);
  assert.equal(parseReply({ ...review, lenses: null }).lenses, null);
  assert.throws(() => parseReply({ ...review, kind: 'message', lenses: [lens] }), /only a review/i);
  assert.throws(() => parseLensAssessments([lens, lens]), /assessed only once/);
  assert.throws(() => parseLensAssessments([{ ...lens, verdict: 'passed' }]), /verdict/);
  assert.throws(() => parseLensAssessments([{ ...lens, summary: ' ' }]), /Lens summary/);
  assert.throws(
    () => parseLensAssessments([{ ...lens, findings: [{ severity: 'blocking', description: 'x', evidence: '' }] }]),
    /Finding evidence/,
  );
  assert.throws(
    () =>
      parseQualityAssessment(
        { pass: 'naming', artifact: 'sha256:x', instructionsDigest: '0'.repeat(64), outcome: 'passed', summary: 'ok' },
        'Refused',
      ),
    /Refused: artifact/,
  );
});

test('a guided task gates on its selected lenses; low-level tasks keep the simplification gate', () => {
  const guided = (passes: QualityPassDefinition[]) =>
    ({ guided: { plan: { quality: { passes } } } }) as unknown as Task;
  assert.deepEqual(requiredQualityLenses(guided([builtInQualityPasses[1]!, builtInQualityPasses[2]!, custom])), [
    'naming',
    'error-handling',
  ]);
  assert.deepEqual(requiredQualityLenses(guided([])), []);
  assert.deepEqual(requiredQualityLenses({} as Task), ['simplification']);
});

test('prompts carry the approved lens and edit pass instructions verbatim', () => {
  const command = { name: 'Check', file: 'node', args: [], timeoutMs: 1000 };
  const checks = { validation: command, acceptance: { ...command, expectedStdout: 'ok' } };
  const prompt = reviewPrompt({
    arbitrating: false,
    verdicts: '[]',
    priorFindings: [],
    lenses: [builtInQualityPasses[0]!, custom],
    checks,
  });
  assert.ok(prompt.includes(builtInQualityPasses[0]!.instructions));
  assert.ok(prompt.includes(custom.instructions));
  assert.match(prompt, /exactly one entry per lens/);
  assert.match(prompt, /source-text searches/);
  assert.match(prompt, /conformance/);
  assert.match(
    reviewPrompt({ arbitrating: false, verdicts: '[]', priorFindings: [], lenses: [], checks }),
    /No quality lenses are selected/,
  );
  // The reviewer judges the approved checks it is shown, not whether acceptance has already run.
  const acceptance = {
    name: 'Smoke acceptance',
    file: 'node',
    args: ['accept.js'],
    timeoutMs: 1000,
    expectedStdout: 'accepted\n',
  };
  const withChecks = reviewPrompt({
    arbitrating: false,
    verdicts: '[]',
    priorFindings: [],
    lenses: [],
    checks: { validation: { name: 'Unit checks', file: 'node', args: ['--test'], timeoutMs: 1000 }, acceptance },
  });
  assert.ok(withChecks.includes(JSON.stringify(acceptance)));
  assert.match(withChecks, /acceptance runs after a passing review/i);
  assert.match(withChecks, /absence is not a finding/);
  assert.match(planningQualityInstructions, /cannot record the results of validation or acceptance/);
  const refactor = builtInQualityPasses[2]!;
  const edit = qualityPassPrompt({ pass: refactor, slicePreparation: undefined });
  assert.ok(edit.includes(refactor.instructions));
  assert.match(edit, /\(refactor\)/);
});
