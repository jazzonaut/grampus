// Input reuse binds ignored dependencies, executable bytes and inherited environment without leaking values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkInputFingerprint } from '../src/verification/check-inputs.js';
import { checkReuseSchema } from '../src/domain/check-input-policy.js';

test('reusable checks invalidate on dependency or executable changes and refuse unsafe inputs', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-inputs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'deps'));
  const executable = join(root, 'runner');
  writeFileSync(executable, 'runner-v1');
  writeFileSync(join(root, 'deps', 'lib'), 'v1');
  const capture = () => checkInputFingerprint(root, executable, ['deps']);
  const first = capture();
  assert.match(first!, /^[a-f0-9]{64}$/);
  assert.equal(capture(), first);
  assert.ok(
    checkInputFingerprint(root, process.execPath, []),
    'Version-manager executable links must bind their resolved binary',
  );
  writeFileSync(join(root, 'deps', 'lib'), 'v2');
  assert.notEqual(capture(), first);
  const changed = capture();
  writeFileSync(executable, 'runner-v2');
  assert.notEqual(capture(), changed);
  assert.equal(checkInputFingerprint(root, executable, ['missing']), null);
  for (const path of ['../escape', 'C:/outside', '/outside', 'a/../outside', 'a\\outside'])
    assert.equal(checkReuseSchema.safeParse({ inputs: [path] }).success, false);
});
