// Captured Playwright failure shapes must narrow diagnostics without guessing commands or outcomes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RepositoryCheck } from '../src/persistence/records.js';
import type { GuidedSlice } from '../src/domain/guided-plan.js';
import { browserFailureFocus, repairDiagnostic } from '../src/verification/failure-focus.js';

const check = (stderr: string, truncated = false) =>
  ({
    result: { stderr, stdout: '', outputTruncated: truncated, exitCode: 1, exitConfirmed: true },
  }) as RepositoryCheck;
const diagnostics: GuidedSlice['diagnostics'] = [
  {
    name: 'browser',
    file: process.execPath,
    args: ['node_modules/@playwright/test/cli.js', 'test'],
    timeoutMs: 15000,
    maxRuns: 3,
    selection: { parameters: [{ name: 'case', flag: '--grep' }], fileSuffixes: ['.spec.ts'] },
  },
];
const output = `1) [chromium] › tests\\e2e\\coop.spec.ts:153:1 › a guest walks (and reconnects) ─────
Error: browserContext.close: Protocol error (Target.disposeBrowserContext): Failed to find context with id ABC
2) [chromium] › tests\\e2e\\glass.spec.ts:535:1 › glass sight [visible]
Error: expect(received).toBeGreaterThan(expected)
Expected: > 0
Received: 0
2 failed
28 passed (9.5m)`;

test('mixed lifecycle and assertion failures retain exact cases and never claim an environment-only failure', () => {
  const focus = browserFailureFocus(check(output));
  assert.equal(focus.complete, true);
  assert.equal(focus.environment, false);
  const repair = repairDiagnostic(check(output), diagnostics);
  assert.deepEqual(repair?.selection.files, ['tests/e2e/coop.spec.ts', 'tests/e2e/glass.spec.ts']);
  assert.equal(
    repair?.selection.parameters?.['case'],
    '(?:a guest walks \\(and reconnects\\)|glass sight \\[visible\\])',
  );
});

test('unknown, partial, overflowing and unapproved failure selections remain unavailable', () => {
  assert.equal(repairDiagnostic(check(output, true), diagnostics), null);
  assert.equal(repairDiagnostic(check(output.replace('2 failed', '3 failed')), diagnostics), null);
  assert.equal(repairDiagnostic(check(output), []), null);
  assert.equal(
    repairDiagnostic(check(output.replace('tests\\e2e\\coop.spec.ts', '..\\secret.spec.ts')), diagnostics),
    null,
  );
  assert.equal(browserFailureFocus(check('Error: browser crashed')).environment, false);
  assert.equal(browserFailureFocus(check('Error: browserContext.close: Test ended.')).environment, true);
});
