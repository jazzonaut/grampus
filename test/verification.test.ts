import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { logExcerpt, runChecks } from '../src/checks/run-checks.js';
import { currentSettings } from '../src/config/settings.js';
import { git, headSha } from '../src/git/git.js';
import { inspectCandidate } from '../src/pipeline/guard.js';
import { excludeWorkerFolder } from '../src/pipeline/workspace-files.js';
import { commitAll, createRepository, useTestSettings, write } from './helpers/task-fixture.js';

const testPatterns = ['**/*.test.*', '**/test/**'];

async function guard(
  repo: string,
  fromSha: string,
  extra: { protectedGlobs?: string[]; protectedFiles?: string[]; checkCommands?: string[] } = {},
) {
  return inspectCandidate({
    cwd: repo,
    fromSha,
    sha: await headSha(repo),
    protectedGlobs: extra.protectedGlobs ?? [],
    protectedFiles: extra.protectedFiles ?? [],
    testPatterns,
    checkConfigPatterns: currentSettings().checkConfigPatterns,
    checkCommands: extra.checkCommands ?? [],
  });
}

test('the guard passes a clean commit and names modified tests', async () => {
  useTestSettings();
  const repo = await createRepository();
  const base = await headSha(repo);
  write(repo, 'greet.js', 'export const greet = n => `Hello, ${n}!`;\n');
  write(repo, 'test/greet.test.js', 'console.log("changed")\n');
  await commitAll(repo, 'Change');
  const result = await guard(repo, base);
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.modifiedTests, ['test/greet.test.js']);
  assert.equal(result.commits, 1);
});

test('the guard fails deleted tests, protected paths, uncommitted work and missing commits', async () => {
  useTestSettings();
  const repo = await createRepository();
  const base = await headSha(repo);
  assert.match((await guard(repo, base)).violations.join(), /No new commit/);

  rmSync(join(repo, 'test', 'greet.test.js'));
  write(repo, 'greet.js', '// changed\n');
  await commitAll(repo, 'Delete the test');
  write(repo, 'scratch.txt', 'left behind');
  const result = await guard(repo, base, { protectedFiles: ['greet.js'] });
  assert.match(result.violations.join('\n'), /Test file deleted: test\/greet.test.js/);
  assert.match(result.violations.join('\n'), /Protected path changed \(M\): greet.js/);
  assert.match(result.violations.join('\n'), /Uncommitted changes remain: scratch.txt/);
});

test('the guard names changed check configuration apart from tests', async () => {
  useTestSettings();
  const repo = await createRepository();
  write(repo, 'scripts/check.mjs', 'process.exit(0);\n');
  await commitAll(repo, 'Add a check script');
  const base = await headSha(repo);
  write(repo, 'Directory.Build.props', '<Project />\n');
  write(repo, 'package.json', '{"type": "module", "scripts": {"test": "exit 0"}}\n');
  write(repo, 'scripts/check.mjs', 'process.exit(0); // relaxed\n');
  write(repo, 'test/vitest.config.js', 'export default {};\n');
  write(repo, 'greet.js', '// changed\n');
  await commitAll(repo, 'Relax the checks');
  const result = await guard(repo, base, { checkCommands: ['node "scripts\\check.mjs"'] });
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.modifiedCheckConfig, ['Directory.Build.props', 'package.json', 'scripts/check.mjs']);
  assert.deepEqual(result.modifiedTests, []);
});

test('the guard notices a rewritten branch', async () => {
  useTestSettings();
  const repo = await createRepository();
  write(repo, 'a.txt', 'a');
  await commitAll(repo, 'A');
  const candidate = await headSha(repo);
  await git(repo, ['reset', '-q', '--hard', 'HEAD~1']);
  write(repo, 'b.txt', 'b');
  await commitAll(repo, 'B');
  assert.match((await guard(repo, candidate)).violations.join(), /rewritten/);
});

test('the worker folder is excluded from Git without changing tracked files', async () => {
  useTestSettings();
  const repo = await createRepository();
  await excludeWorkerFolder(repo);
  await excludeWorkerFolder(repo);
  write(repo, '.grampus/spec-1/spec.md', '# spec');
  const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.split('\n').filter(line => line === '/.grampus/').length, 1);
  assert.equal((await git(repo, ['status', '--porcelain'])).trim(), '');
});

test('checks record pass, failure, timeout and flaky reruns', async () => {
  useTestSettings();
  const dir = mkdtempSync(join(tmpdir(), 'grampus-checks-'));
  const counter = join(dir, 'count');
  writeFileSync(counter, '0');
  const flaky = `node -e "const f=process.argv[1];const n=+require('fs').readFileSync(f,'utf8')+1;require('fs').writeFileSync(f,String(n));process.exit(n===1?1:0)" "${counter}"`;
  const results = await runChecks(
    dir,
    [
      { name: 'pass', command: 'node -e "console.log(42)"' },
      { name: 'fail', command: 'node -e "console.error(\'boom\');process.exit(3)"' },
      { name: 'slow', command: 'node -e "console.log(\'started\');setTimeout(()=>{},60000)"', timeoutSeconds: 1 },
      { name: 'flaky', command: flaky },
    ],
    dir,
    { rerunFailures: true },
  );
  const [pass, fail, slow, flakyResult] = results;
  assert.equal(pass?.passed, true);
  assert.match(readFileSync(pass?.logPath ?? '', 'utf8'), /42/);
  assert.equal(fail?.passed, false);
  assert.equal(fail?.exitCode, 3);
  assert.match(logExcerpt(fail?.logPath ?? ''), /boom/);
  assert.equal(slow?.timedOut, true);
  assert.match(readFileSync(slow?.logPath ?? '', 'utf8'), /started[\s\S]*timed out/);
  assert.equal(flakyResult?.passed, true);
  assert.equal(flakyResult?.flaky, true);
});
