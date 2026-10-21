// Progress updates keep the evidence a repair responds to and say that work is resuming.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkIssue } from '../src/verification/check-output.js';
import { reviewCheckEvidence } from '../src/verification/check-evidence.js';
import type { RepositoryCheck } from '../src/verification/checks.js';
import { workspaceInstructions } from '../src/execution/workspace-instructions.js';
import {
  implementationPrompt,
  progressContinuationNote,
  progressFeedback,
  qualityPassPrompt,
} from '../src/orchestration/guided/prompts.js';

test('a progress update keeps the repair evidence and never stacks its note', () => {
  const evidence = JSON.stringify({ reason: 'expected hello world, received hello' });
  const once = progressFeedback(evidence);
  assert.ok(once.startsWith(progressContinuationNote));
  assert.ok(once.includes(evidence), 'the failing check survives a progress update');
  assert.equal(progressFeedback(once), once);
  assert.equal(progressFeedback(''), progressContinuationNote);
});

test('a continuing quality pass is told to resume', () => {
  const pass = { id: 'simplify', title: 'Simplify', instructions: 'Remove duplication.' } as Parameters<
    typeof qualityPassPrompt
  >[0]['pass'];
  assert.ok(!qualityPassPrompt({ pass, slicePreparation: undefined }).includes(progressContinuationNote));
  assert.ok(
    qualityPassPrompt({ pass, slicePreparation: undefined, continuing: true }).startsWith(progressContinuationNote),
  );
});

test('review evidence holds only checks of the reviewed artifact, with excerpts when they cannot be read', () => {
  const check = (id: string, artifact: string) =>
    ({
      id,
      purpose: 'acceptance',
      phase: 'passed',
      spec: { name: id, file: 'node', args: ['test.js'], artifact },
      result: { reason: 'exited', exitCode: 0, stdout: 'all good', stderr: '' },
      error: null,
    }) as unknown as RepositoryCheck;
  const checks = [check('old', 'sha256:old'), check('current', 'sha256:current')];
  const readable = JSON.parse(reviewCheckEvidence(checks, 'sha256:current', true)) as Record<string, unknown>[];
  assert.deepEqual(
    readable.map(item => item['checkId']),
    ['current'],
  );
  assert.ok(readable[0]?.['readMore'] && !('stdout' in readable[0]));
  const unreadable = JSON.parse(reviewCheckEvidence(checks, 'sha256:current', false)) as Record<string, unknown>[];
  const [first] = unreadable;
  assert.ok(first && 'stdout' in first && !('readMore' in first));
});

test('a clean exit that leaves processes behind says so before its success output', () => {
  const check = {
    id: 'leftover',
    spec: { name: 'build' },
    phase: 'failed',
    error: null,
    result: {
      stdout: 'Build succeeded.\n',
      stderr: '',
      outputTruncated: false,
      reason: 'descendants_remaining',
      exitCode: 0,
      exitConfirmed: true,
    },
  } as unknown as RepositoryCheck;
  assert.match(checkIssue(check), /^The command exited 0 but left processes running/);
});

// Regression: a native implementer ran all eight full browser shards itself for 70 minutes before
// submitting, duplicating acceptance the controller runs anyway and chasing unrelated failures.
test('native prompts leave broad and sharded verification to the controller', () => {
  const prompt = implementationPrompt({ slicePreparation: undefined, feedback: '' });
  assert.match(prompt, /run focused checks for what you changed/);
  assert.match(prompt, /never broad, whole-suite or sharded runs/);
  assert.doesNotMatch(prompt, /meaningful checks/);
  assert.match(workspaceInstructions, /Never run broad, whole-suite or sharded test runs yourself/);
  assert.doesNotMatch(workspaceInstructions, /meaningful checks/);
});

test('a repository rule to run the full suite is met by controller verification', () => {
  assert.match(workspaceInstructions, /repository instructions require a full or broad suite/);
  assert.match(
    implementationPrompt({ slicePreparation: undefined, feedback: '' }),
    /even where repository instructions ask for a full suite/,
  );
});
