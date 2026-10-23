// Mixed runner output must retain useful failures without inventing portability.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assessCheck } from '../src/checks/failure.js';
import { renderComparison } from '../src/compare/status.js';

test('named assertions survive a misleading runner footer and unrelated API failures', () => {
  const logPath = join(mkdtempSync(join(tmpdir(), 'grampus-assertions-')), 'check.log');
  writeFileSync(
    logPath,
    `FAIL tests/hold.test.ts > retains final standings
AssertionError: expected [ 'B' ] to deeply equal [ 'A', 'B' ]
 at tests/hold.test.ts:215:55
FAIL tests/hold.test.ts > uses private API
TypeError: sim.remove is not a function
Command "vitest" not found
`,
  );
  const result = {
    name: 'hold',
    command: 'vitest',
    exitCode: 1,
    timedOut: false,
    durationMs: 1,
    logPath,
    flaky: false,
    passed: false,
  };
  const assessment = assessCheck(result, false);
  assert.equal(assessment.outcome, 'execution-error');
  assert.deepEqual(assessment.assertions, [
    {
      test: 'tests/hold.test.ts > retains final standings',
      detail: "AssertionError: expected [ 'B' ] to deeply equal [ 'A', 'B' ]",
      outcome: 'unknown',
    },
  ]);
  assert.equal(assessCheck(result, true).assertions?.[0]?.outcome, 'behavioural-failure');
  const shown = renderComparison({
    comparisonId: 'compare',
    title: 'Snake',
    mode: 'full',
    entries: [],
    waiting: [],
    crossCheck: null,
    needsYou: null,
    refused: null,
    finished: null,
    lastStop: null,
    assertions: assessment.assertions.map(assertion => ({
      owner: 'claude',
      candidate: 'codex',
      check: 'hold',
      assertion,
    })),
  });
  assert.match(shown, /retains final standings \[unknown\]/);
  assert.match(shown, /expected \[ 'B' \]/);
});

test('passing tests and unlabelled assertions do not become named failure evidence', () => {
  const logPath = join(mkdtempSync(join(tmpdir(), 'grampus-assertions-')), 'check.log');
  writeFileSync(logPath, 'AssertionError: unrelated\nok 1 - passed test\nAssertionError: printed text\n');
  const assessment = assessCheck(
    {
      name: 'test',
      command: 'test',
      exitCode: 1,
      timedOut: false,
      durationMs: 1,
      logPath,
      flaky: false,
      passed: false,
    },
    false,
  );
  assert.deepEqual(assessment.assertions, []);
});
