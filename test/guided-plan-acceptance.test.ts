// Guided plan tests: a slice's ordered acceptance checks as approval normalises them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeGuidedPlan } from '../src/domain/guided-plan.js';
import { planLimits } from '../src/config/limits.js';

function proposal(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-acceptance-plan-')),
    repo = join(root, 'repo');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a');
  git('add', 'a.txt');
  git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', 'Initial');
  return (acceptance: unknown) => ({
    brief: { title: 'Checks', outcome: 'Checks', criteria: ['Checks'], plan: 'Check in order' },
    workspace: { repo, path: join(root, 'workspace') },
    slices: [
      {
        scope: { files: ['a.txt'] },
        validation: { file: 'node', args: [] },
        acceptance,
        message: 'Checks',
      },
    ],
  });
}

const check = (name: string, timeoutMs?: number) => ({
  name,
  file: 'node',
  args: ['-e', `console.log(${JSON.stringify(name)})`],
  expectedStdout: `${name}\n`,
  ...(timeoutMs === undefined ? {} : { timeoutMs }),
});

test('a slice keeps its acceptance checks in order, each with its own timeout', t => {
  const plan = proposal(t);
  const { slices } = normalizeGuidedPlan(plan([check('Unit', 60_000), check('Browser', 600_000)]));
  assert.deepEqual(
    slices[0]!.acceptance.map(item => [item.name, item.timeoutMs, item.expectedStdout]),
    [
      ['Unit', 60_000, 'Unit\n'],
      ['Browser', 600_000, 'Browser\n'],
    ],
  );
});

test('acceptance must be a nonempty bounded list of distinctly named checks', t => {
  const plan = proposal(t);
  const refused = (acceptance: unknown, message: RegExp) =>
    assert.throws(() => normalizeGuidedPlan(plan(acceptance)), message, JSON.stringify(acceptance));
  const listMessage = new RegExp(`Slice 1 acceptance: Acceptance requires 1–${planLimits.acceptanceChecks} checks`);
  refused(check('Single'), listMessage);
  refused([], listMessage);
  refused(
    Array.from({ length: planLimits.acceptanceChecks + 1 }, (_, index) => check(`Check ${index}`)),
    listMessage,
  );
  refused([check('Same'), check('Same')], /Slice 1 acceptance: Acceptance check names must be distinct: Same$/);
  // Each check is still validated on its own and named by its position.
  refused([check('Fine'), { ...check('Unobserved'), expectedStdout: undefined }], /Slice 1 acceptance 2: /);
});
