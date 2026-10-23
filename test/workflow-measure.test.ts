// Evidence categories and accounting must preserve unknowns and count actual executions once.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assessCheck } from '../src/checks/failure.js';
import { crossCheckCounts } from '../src/compare/outcomes.js';
import type { CheckResult, StoredEvent, TaskEvent } from '../src/domain/events.js';
import { interventionCounts, measurePhases } from '../src/measure/phases.js';

const result: CheckResult = {
  name: 'tests',
  command: 'node --test',
  passed: false,
  exitCode: 1,
  timedOut: false,
  flaky: false,
  durationMs: 100,
  logPath: 'check.log',
};
const events = (items: TaskEvent[]): StoredEvent[] => items.map(item => ({ ...item, at: new Date().toISOString() }));

test('reusing spec evidence for baseline does not charge a second check execution', () => {
  const evidence = events([
    { type: 'checks.recorded', specVersion: 1, phase: 'spec', round: 1, sha: 'base', results: [result] },
    { type: 'checks.recorded', specVersion: 1, phase: 'baseline', round: 0, sha: 'base', results: [result] },
    {
      type: 'checks.recorded',
      specVersion: 1,
      phase: 'verify',
      round: 0,
      sha: 'built',
      results: [{ ...result, logPath: 'verify.log' }],
    },
  ]);
  assert.equal(measurePhases(evidence, []).find(phase => phase.phase === 'verification')?.checkMs, 200);
});

test('cross-check failures distinguish portability, infrastructure and API compatibility', () => {
  const dir = mkdtempSync(join(tmpdir(), 'grampus-outcomes-'));
  const logPath = join(dir, 'tests.log');
  const check = { ...result, logPath };
  writeFileSync(logPath, 'AssertionError: incorrect result');
  assert.equal(assessCheck(check, false).outcome, 'unknown');
  assert.equal(assessCheck(check, true).outcome, 'behavioural-failure');
  writeFileSync(logPath, 'MODULE_NOT_FOUND: runner\nAssertionError: incomplete');
  assert.equal(assessCheck(check, true).outcome, 'execution-error');
  writeFileSync(logPath, "error TS2305: Module has no exported member 'start'.\nAssertionError: incomplete");
  assert.equal(assessCheck(check, true).outcome, 'incompatible');
  writeFileSync(logPath, 'process exited unsuccessfully');
  assert.equal(assessCheck(check, true).outcome, 'unknown');
  assert.equal(assessCheck({ ...check, timedOut: true }, true).outcome, 'execution-error');
});

test('cross-check execution errors remain in the comparison denominator', () => {
  const evidence = { taskId: 'spec', sha: 'sha', round: 0, specVersion: 1, specHash: 'hash', revision: null };
  const base = {
    specOf: 'spec',
    candidate: 'result',
    sha: 'sha',
    error: null,
    binding: { owner: evidence, candidate: { ...evidence, taskId: 'result' } },
  };
  const counts = crossCheckCounts([
    { ...base, results: [{ ...result, passed: true }] },
    { ...base, results: null, error: 'Unclean candidate' },
    { ...base, results: [result], assessments: [{ name: 'tests', outcome: 'incompatible', reason: 'API' }] },
    {
      ...base,
      results: [result],
      assessments: [{ name: 'tests', outcome: 'behavioural-failure', reason: 'Assertion' }],
    },
    { ...base, results: [result] },
  ]);
  assert.deepEqual(counts, { passed: 1, total: 5, errors: 1, incompatible: 1, failed: 1, unknown: 1 });
});

test('intervention attribution uses explicit purpose and preserves ambiguous corrections', () => {
  const command = { id: 'command', at: new Date().toISOString(), source: 'cli' as const };
  assert.deepEqual(
    interventionCounts(
      events([
        { type: 'attention.needed', reason: 'setup-failed:1', detail: 'Setup failed', options: ['retry', 'abandon'] },
        { type: 'command.applied', command: { ...command, kind: 'retry' } },
        { type: 'command.applied', command: { ...command, kind: 'continue', guidance: 'Please fix it' } },
        {
          type: 'command.applied',
          command: { ...command, kind: 'continue', guidance: 'Correct reconnect', purpose: 'implementation' },
        },
      ]),
    ),
    { implementation: 1, workflow: 1, unknown: 1 },
  );
});
