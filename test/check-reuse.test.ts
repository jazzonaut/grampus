// Uses actual supervised checks and ignored inputs to exercise the reuse decision's negative cases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkInputFingerprint } from '../src/verification/check-inputs.js';
import { reusableDiagnostic } from '../src/verification/check-reuse.js';
import { fixture, windows } from './helpers/checks.js';

test('ignored dependency changes and newer failures invalidate diagnostic reuse', windows, async t => {
  const f = await fixture(t),
    cwd = f.workspaces.path(f.workspace.id);
  mkdirSync(join(cwd, 'generated'));
  writeFileSync(join(cwd, 'generated', 'dependency'), 'v1');
  const spec = { ...(await f.spec()), reuse: { inputs: ['generated'] } };
  const checked = await f.checks.run(f.execution.id, spec);
  const source = { ...checked, implementationId: 'source' };
  const target = { ...checked, id: 'gate', readiness: undefined };
  const fingerprint = checkInputFingerprint(cwd, spec.file, spec.reuse.inputs);
  assert.equal(reusableDiagnostic([source], target, fingerprint)?.id, source.id);
  writeFileSync(join(cwd, 'generated', 'dependency'), 'v2');
  const changed = checkInputFingerprint(cwd, spec.file, spec.reuse.inputs);
  assert.notEqual(changed, fingerprint);
  assert.equal(reusableDiagnostic([source], target, changed), null);
  assert.equal(reusableDiagnostic([source, { ...source, id: 'later', phase: 'failed' }], target, fingerprint), null);
  assert.equal(reusableDiagnostic([{ ...source, phase: 'recovery_required' }], target, fingerprint), null);
  assert.equal(
    reusableDiagnostic([source], { ...target, spec: { ...spec, criteria: ['criterion'] } }, fingerprint),
    null,
  );
});
