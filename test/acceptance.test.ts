import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertAcceptance, validateExpectations } from '../src/acceptance.js';
import type { RepositorySnapshot } from '../src/artifacts.js';

test('acceptance checks semantic JSON and captured file bytes, including binary hashes and deletions', () => {
  const content = 'checked\n',
    hash = createHash('sha256').update(content).digest('hex');
  const snapshot = {
    files: [
      { path: 'result.txt', sha256: hash },
      { path: 'removed.bin', sha256: null },
    ],
  } as RepositorySnapshot;
  const output = {
    stdout: '{"b":2, "a":1}\n',
    stderr: '',
    reason: 'exited',
    exitCode: 0,
    exitConfirmed: true,
    outputTruncated: false,
  };
  const expectations = {
    stdoutJson: { a: 1, b: 2 },
    stderr: '',
    files: [
      { path: 'result.txt', content, sha256: hash },
      { path: 'removed.bin', absent: true as const },
    ],
  };
  validateExpectations(undefined, expectations);
  assertAcceptance(snapshot, output, undefined, expectations);
  assert.throws(() => assertAcceptance(snapshot, output, undefined, { stdoutJson: { a: 2, b: 2 } }), /JSON output/);
  assert.throws(
    () => assertAcceptance(snapshot, output, undefined, { files: [{ path: 'result.txt', content: 'wrong' }] }),
    /file content/,
  );
  assert.throws(
    () => assertAcceptance(snapshot, output, undefined, { files: [{ path: 'ignored/file', absent: true }] }),
    /outside the verified/,
  );
  assert.throws(
    () => assertAcceptance(snapshot, { ...output, outputTruncated: true }, undefined, expectations),
    /truncated/,
  );
  assert.throws(() => validateExpectations(undefined, {}), /requires/);
  assert.throws(() => validateExpectations(undefined, { files: [{ path: '../outside', content: '' }] }), /relative/);
  assert.throws(
    () => validateExpectations(undefined, { files: [{ path: 'result.txt', absent: true, content: '' }] }),
    /Invalid file/,
  );
});
