// Guided task tests: large planned slices with paged cumulative review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided-tasks.js';
import { guidedTaskView } from '../src/orchestration/guided-status.js';
import { Workflow } from '../src/domain/workflow.js';
import { runCheckProcess } from '../src/process/check-process.js';
import type { ImplementationRun } from '../src/execution/implementations.js';
import { Kickoffs } from '../src/orchestration/kickoff.js';
import { repositoryTools } from '../src/repository/repository-tools.js';
import { windows, message, review, git, services, fixture } from './helpers/guided-tasks.js';

test(
  'three large planned slices page cumulative review and require separate assessments and final whole-task acceptance',
  windows,
  async t => {
    const f = fixture(t);
    writeFileSync(join(f.repo, 'cli.js'), "console.log('pending');\n");
    writeFileSync(join(f.repo, 'notes.js'), 'module.exports = null;\n');
    git(f.repo, 'add', '.');
    git(f.repo, 'commit', '-m', 'CLI fixture baseline');
    const criteria = [
      'Library exposes hello world',
      'CLI prints hello world with a newline',
      'Notes expose the documented contract',
    ];
    const libraryCheck =
      "require('node:assert/strict').equal(require('./greeting.js'),'hello world');console.log('library ok');";
    const allCheck =
      libraryCheck +
      "require('node:assert/strict').equal(require('node:child_process').execFileSync(process.execPath,['cli.js'],{encoding:'utf8'}),'hello world\\n');console.log('cli ok');";
    const finalCheck =
      allCheck + "require('node:assert/strict').equal(require('./notes.js'),'documented');console.log('notes ok');";
    const plan = {
      ...f.plan,
      brief: {
        ...f.plan.brief,
        criteria,
        slices: [
          { title: 'Library', plan: 'Expose the greeting', criteria: [criteria[0]!] },
          { title: 'CLI integration', plan: 'Reuse the library and verify both', criteria: [criteria[1]!] },
          {
            title: 'Notes and final integration',
            plan: 'Document the contract and verify all criteria',
            criteria: [criteria[2]!],
          },
        ],
      },
      slices: [
        {
          scope: { files: ['greeting.js'] },
          validation: { file: 'node', args: ['-e', libraryCheck], timeoutMs: 15000 },
          acceptance: { file: 'node', args: ['-e', libraryCheck], expectedStdout: 'library ok\n', timeoutMs: 15000 },
          message: 'Expose greeting library',
        },
        {
          scope: { files: ['cli.js'] },
          validation: { file: 'node', args: ['-e', allCheck], timeoutMs: 15000 },
          acceptance: {
            file: 'node',
            args: ['-e', allCheck],
            expectedStdout: 'library ok\ncli ok\n',
            timeoutMs: 15000,
          },
          message: 'Integrate greeting CLI',
        },
        {
          scope: { files: ['notes.js'] },
          validation: { file: 'node', args: ['-e', finalCheck], timeoutMs: 15000 },
          acceptance: {
            file: 'node',
            args: ['-e', finalCheck],
            expectedStdout: 'library ok\ncli ok\nnotes ok\n',
            timeoutMs: 15000,
          },
          message: 'Document and verify greeting',
        },
      ],
    };
    const tasks = new GuidedTasks(f.store, {
      ...services(),
      implementationRunner: options => {
        const run = f.store.implementation<ImplementationRun>(options.receipt!.checkId);
        const file = run.policy.files[0]!,
          source =
            file === 'greeting.js'
              ? "module.exports = 'hello world';\n"
              : file === 'cli.js'
                ? "console.log(require('./greeting.js'));\n"
                : "module.exports = 'documented';\n";
        return runCheckProcess({
          ...options,
          args: [
            '-e',
            `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(file)},${JSON.stringify(source)}+'//'+ 'x'.repeat(190*1024));
      fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))},JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)},result:{status:'completed',reply:${JSON.stringify(message)},usage:null,error:null}}));`,
          ],
        });
      },
      connector: async (_, options) => ({
        turn: async prompt => {
          assert.ok(Buffer.byteLength(prompt) < 2 * 1024 * 1024);
          const access = options.repository!;
          assert.ok('snapshot' in access);
          const read = repositoryTools(access, options.emit, () => true);
          if ('snapshot' in access)
            for (const change of access.snapshot.diff)
              for (const side of ['before', 'after'] as const) {
                let offset: number | null = 0,
                  content = '';
                while (offset !== null) {
                  const page = read('grampus_read_changes', { path: change.path, side, offset }) as {
                    content: string | null;
                    nextOffset: number | null;
                  };
                  content += page.content ?? '';
                  offset = page.nextOffset;
                }
                assert.equal(content, (side === 'before' ? change.previousContent : change.content) ?? '');
              }
          return { status: 'completed', reply: review, usage: null, error: null };
        },
        close: async () => {},
        interrupt: async () => {},
      }),
    });
    const kickoffs = new Kickoffs(f.store, async () => ({
      turn: async () => ({
        status: 'completed',
        reply: { ...message, text: JSON.stringify(plan) },
        usage: null,
        error: null,
      }),
      interrupt: async () => {},
      close: async () => {},
    }));
    const kickoffId = kickoffs.create({
      repo: f.repo,
      request: 'Deliver the full greeting library and CLI task in sequential slices',
    });
    const proposal = await kickoffs.send(kickoffId);
    assert.equal(proposal.error, null);
    const id = kickoffs.prepare(kickoffId, proposal.candidateDigest!),
      draft = tasks.get(id);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.plan.slices.length, 3);
    tasks.approve(id, draft.version, draft.digest);
    await tasks.run(id);
    const first = await tasks.authorize(id);
    assert.equal(first.status, 'awaiting_assessment', first.note);
    const next = await tasks.assess(id, 'passed', 'One exported string; the CLI remains for the next slice');
    assert.equal(next.status, 'awaiting_scope', next.note);
    assert.equal(next.sliceIndex, 1);
    assert.notEqual(next.executionId, first.executionId);
    const firstDelivery = f.store.deliveries<import('../src/execution/deliveries.js').Delivery>(first.executionId!)[0]!;
    const workspace = guidedTaskView(f.store, id).workspace!;
    const libraryBlob = git(workspace.path!, 'rev-parse', 'HEAD:greeting.js');
    await tasks.authorize(id);
    const third = await tasks.assess(id, 'passed', 'The CLI reuses the delivered library with one output statement');
    assert.equal(third.status, 'awaiting_scope', third.note);
    assert.equal(third.sliceIndex, 2);
    const finalAssessment = await tasks.authorize(id);
    assert.equal(finalAssessment.status, 'awaiting_assessment', finalAssessment.note);
    const done = await tasks.assess(id, 'passed', 'The documented contract and final integration are consistent');
    assert.equal(done.status, 'complete', done.note);
    assert.equal(git(workspace.path!, 'rev-parse', 'HEAD~2'), firstDelivery.commit);
    assert.equal(git(workspace.path!, 'rev-parse', 'HEAD:greeting.js'), libraryBlob);
    assert.deepEqual(guidedTaskView(f.store, id).checks.at(-1)!.spec.criteria, criteria);
    assert.equal(new Workflow(f.store).get(id).slice!.completed.length, 3);
  },
);
