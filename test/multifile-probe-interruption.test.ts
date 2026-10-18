// Multi-file probe tests: interruption pilot recovery through a new CLI.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  expectedStdout,
  fixtureFiles,
  oracle,
  obsoleteFile,
  obsoleteContent,
} from '../src/probes/multifile-fixture.js';
import { Store } from '../src/persistence/store.js';
import { Workflow } from '../src/domain/workflow.js';
import { Workspaces } from '../src/repository/workspaces.js';
import { Executions } from '../src/execution/executions.js';
import { Checks } from '../src/verification/checks.js';
import { interruptAfterEdit } from '../src/probes/probe-interruption.js';
import { Implementations } from '../src/execution/implementations.js';
import { runCheckProcess } from '../src/process/check-process.js';
import { runSession } from '../src/execution/sessions.js';
import { Deliveries } from '../src/execution/deliveries.js';
import { renderReport } from '../src/reporting/report.js';
import { library, command } from './helpers/multifile-probe.js';

for (const mode of ['existing', 'new', 'delete'] as const)
  test(
    `interruption pilot recovers a partial ${mode} file change through a new CLI without replay`,
    { skip: process.platform !== 'win32' },
    async t => {
      const createLibrary = mode === 'new',
        deleteObsolete = mode === 'delete';
      const root = mkdtempSync(join(tmpdir(), 'grampus-pilot-crash-')),
        repo = join(root, 'repo');
      mkdirSync(repo);
      const git = (...args: string[]) =>
        execFileSync('git', ['-C', repo, ...args], { windowsHide: true, stdio: 'pipe' });
      git('init', '-b', 'main');
      git('config', 'user.name', 'Fixture');
      git('config', 'user.email', 'fixture@invalid');
      git('config', 'commit.gpgsign', 'false');
      git('config', 'core.autocrlf', 'false');
      for (const [file, content] of Object.entries(fixtureFiles)) {
        if (createLibrary && file === 'summary.cjs') continue;
        writeFileSync(join(repo, file), content);
      }
      if (deleteObsolete) writeFileSync(join(repo, obsoleteFile), obsoleteContent);
      git('add', '.');
      git('commit', '-m', 'Baseline');
      const store = new Store(join(root, 'grampus.sqlite'));
      t.after(() => {
        store.close();
        rmSync(root, { recursive: true, force: true });
      });
      const workflow = new Workflow(store),
        task = workflow.create({
          title: 'Crash pilot fixture',
          outcome: 'Edit both files',
          criteria: ['Both files'],
          plan: 'Exercise crash observer with an offline tool',
        });
      workflow.approve(task.id, 1);
      const workspace = await new Workspaces(store).create(task.id, 1, repo, join(root, 'workspace'));
      const execution = await new Executions(store).create(workspace.id, 1, 'claude');
      const snapshot = await new Checks(store).snapshot(execution.id);
      const policy = {
        artifact: snapshot.artifact,
        instructionsDigest: snapshot.instructionsDigest,
        files: createLibrary ? ['cli.cjs'] : ['summary.cjs', 'cli.cjs'],
        ...(createLibrary ? { create: ['summary.cjs'] } : {}),
        ...(deleteObsolete ? { delete: [obsoleteFile] } : {}),
      };
      const controller = join(root, 'fixture-controller.mjs');
      const url = (name: string) => JSON.stringify(new URL(`../src/${name}.js`, import.meta.url).href);
      const tool = deleteObsolete
        ? `require('node:fs').unlinkSync('${obsoleteFile}'); setTimeout(() => {}, 30000);`
        : `require('node:fs').writeFileSync('summary.cjs', 'exports.summarize = () => null;\\n'); setTimeout(() => {}, 30000);`;
      writeFileSync(
        controller,
        `import {Store} from ${url('persistence/store')}; import {Implementations} from ${url('execution/implementations')};
    import {runCheckProcess} from ${url('process/check-process')};
    const store = new Store(${JSON.stringify(store.path)});
    await new Implementations(store).run(${JSON.stringify(execution.id)}, ${JSON.stringify(policy)}, undefined, {},
      options => runCheckProcess({...options, args: ['-e', ${JSON.stringify(tool)}]}));`,
      );
      const result = await interruptAfterEdit(store, execution, workspace, root, policy, controller);
      assert.equal(result.passed, true);
      assert.equal(result.taskPhase, 'stopped');
      assert.equal(result.inferenceReplayed, false);
      assert.equal(result.observedChange.kind, deleteObsolete ? 'delete' : 'edit');
      assert.equal(readFileSync(join(workspace.path, 'cli.cjs'), 'utf8'), fixtureFiles['cli.cjs']);
      assert.ok(store.events(task.id).some(event => event.type === 'probe.interruption_verified'));
      if (mode === 'existing') {
        // Prove the usable recovery path: a fresh attempt can finish the preserved
        // partial implementation under the original approval, without reviving its owner.
        const fresh = await new Executions(store).create(workspace.id, 1, 'claude');
        assert.notEqual(fresh.attemptId, execution.attemptId);
        assert.notEqual(fresh.sessionId, execution.sessionId);
        assert.equal(workflow.get(task.id).approvedVersion, 1);
        await assert.rejects(new Implementations(store).run(execution.id, policy), /outdated task attempt/);
        const checks = new Checks(store),
          before = await checks.snapshot(fresh.id);
        const resumed = await new Implementations(store).run(
          fresh.id,
          {
            artifact: before.artifact,
            instructionsDigest: before.instructionsDigest,
            files: ['summary.cjs', 'cli.cjs'],
          },
          'Complete the retained partial work',
          {},
          options =>
            runCheckProcess({
              ...options,
              args: [
                '-e',
                `
      const fs = require('node:fs');
      fs.writeFileSync('summary.cjs', ${JSON.stringify(library)});
      fs.writeFileSync('cli.cjs', ${JSON.stringify(command)});
      fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))}, JSON.stringify({
        id: ${JSON.stringify(options.receipt!.checkId)}, result: { status: 'completed',
          reply: { kind: 'message', text: 'Offline fixture completed both files', questions: [], findings: [] }, usage: null, error: null }
      }));
    `,
              ],
            }),
        );
        assert.equal(resumed.phase, 'completed', JSON.stringify(resumed));
        const submitted = await checks.snapshot(fresh.id);
        const spec = {
          name: 'Recovered task behavior',
          artifact: submitted.artifact,
          instructionsDigest: submitted.instructionsDigest,
          file: process.execPath,
          args: ['-e', oracle],
          timeoutMs: 15000,
        };
        const validation = await checks.run(fresh.id, spec);
        assert.equal(validation.phase, 'passed', JSON.stringify(validation));
        await checks.finish(fresh.id, validation.id);
        await checks.simplify(fresh.id, {
          artifact: submitted.artifact,
          instructionsDigest: submitted.instructionsDigest,
          outcome: 'passed',
          summary: 'Offline fixture: one calculation function and a CLI that reuses it; no additional abstractions',
        });
        const review = await new Executions(store).create(workspace.id, 1, 'codex', 'review');
        const reviewed = await runSession(
          store,
          review.sessionId,
          'Review the recovered task',
          { artifactReview: true },
          async () => ({
            turn: async () => ({
              status: 'completed',
              reply: { kind: 'review', text: 'Offline fixture review; no live inference', questions: [], findings: [] },
              usage: null,
              error: null,
            }),
            interrupt: async () => {},
            close: async () => {},
          }),
        );
        assert.equal(reviewed.status, 'completed');
        const acceptance = await checks.run(fresh.id, { ...spec, criteria: task.brief.criteria, expectedStdout });
        assert.equal(acceptance.phase, 'passed', JSON.stringify(acceptance));
        const delivered = await new Deliveries(store).run(fresh.id, {
          artifact: submitted.artifact,
          instructionsDigest: submitted.instructionsDigest,
          message: 'Complete recovered task fixture',
          timeoutMs: 15000,
        });
        assert.equal(delivered.phase, 'delivered', JSON.stringify(delivered));
        assert.equal(workflow.get(task.id).phase, 'complete');
        assert.equal(store.lease(workspace.id), null);
        assert.equal(
          execFileSync('git', ['-C', workspace.path, 'status', '--porcelain'], { encoding: 'utf8', windowsHide: true }),
          '',
        );
        assert.equal(
          execFileSync('git', ['-C', workspace.path, 'rev-parse', 'HEAD^'], {
            encoding: 'utf8',
            windowsHide: true,
          }).trim(),
          workspace.baseCommit,
        );
        const report = renderReport(store, task.id);
        assert.match(report, /implementation.recovered/);
        assert.match(report, /delivery.settled/);
        assert.equal(store.implementations(execution.id).length, 1, 'The interrupted operation was never replayed');
      }
    },
  );
