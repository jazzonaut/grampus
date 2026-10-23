// Tests-first evidence must identify an executed assertion in an added or changed test.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { runChecks } from '../src/checks/run-checks.js';
import { headSha } from '../src/git/git.js';
import { DriverCore } from '../src/pipeline/driver-core.js';
import { recordTestBaseline } from '../src/pipeline/test-evidence.js';
import { workerFile } from '../src/pipeline/workspace-files.js';
import { commitAll, createHarness, goodWorkers, worktreeOf, write } from './helpers/task-fixture.js';

test('tests-first attribution reads the full log and requires a named failing test and assertion', async () => {
  const h = await createHarness(h => goodWorkers(h));
  const cwd = worktreeOf(h);
  write(
    cwd,
    'test/accept.test.js',
    `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { greet } from '../greet.js';
test('greets Ada', () => assert.equal(greet('Ada'), 'Hello, Ada!'));
test('later output', () => console.log('noise'.repeat(3000)));
`,
  );
  await commitAll(cwd, 'Add acceptance test');
  const sha = await headSha(cwd);
  // A nested node:test runner must not inherit the outer runner's child-process marker.
  write(
    cwd,
    'run-test.js',
    `import { spawnSync } from 'node:child_process';
const { NODE_TEST_CONTEXT, ...env } = process.env;
const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/accept.test.js'], { env, stdio: 'inherit' });
process.exit(run.status ?? 1);`,
  );
  const results = await runChecks(
    cwd,
    [{ name: 'acceptance', command: 'node run-test.js' }],
    h.store.checksDir('baseline', 0),
    { rerunFailures: false },
  );
  h.store.append({ type: 'tests.recorded', sha, files: ['test/accept.test.js'] });
  h.store.append({ type: 'checks.recorded', specVersion: 1, phase: 'baseline', round: 0, sha, results });
  const core = new DriverCore(h.store, h.orca, () => {});
  const reportPath = workerFile(cwd, 'tests:0', 'report.json');
  const claim = {
    check: 'acceptance',
    file: 'test/accept.test.js',
    test: 'greets Ada',
    criterion: 'greeting',
    expectedOutput: 'ERR_ASSERTION',
  };
  const assess = (failures: unknown[], log?: string) => {
    core.state.testBaseline = null;
    if (log !== undefined) writeFileSync(results[0]!.logPath, log);
    writeFileSync(reportPath, JSON.stringify({ failures }));
    recordTestBaseline(core, cwd);
    return h.state().testBaseline?.assessments[0];
  };
  assert.equal(
    assess([claim])?.outcome,
    'behavioural-failure',
    'a real assertion before a long log tail is still evidence',
  );
  assert.equal(assess([{ ...claim, test: 'never executed' }])?.outcome, 'unknown');
  assert.equal(assess([{ ...claim, file: 'test/unchanged.test.js' }])?.outcome, 'unknown');
  assert.equal(
    assess([claim], 'not ok 1 - another test\nAssertionError ERR_ASSERTION\n at test/accept.test.js\nok 2 - greets Ada')
      ?.outcome,
    'unknown',
  );
  assert.equal(
    assess([{ check: 'acceptance', criterion: 'greeting', expectedOutput: 'custom failure' }], 'custom failure')
      ?.outcome,
    'unknown',
    'arbitrary matching text is not a failed assertion',
  );
  assert.equal(
    assess([claim], 'not ok 1 - greets Ada\nAssertionError ERR_ASSERTION\n at test/accept.test.js\nMODULE_NOT_FOUND')
      ?.outcome,
    'execution-error',
  );
  assert.equal(
    assess([claim], 'not ok 1 - greets Ada\nerror TS2305\n at test/accept.test.js')?.outcome,
    'incompatible',
  );
});
