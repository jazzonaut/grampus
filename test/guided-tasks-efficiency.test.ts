// Exercises diagnostic families, implementation observations, grouped readiness and complete step timing together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GuidedTasks } from '../src/orchestration/guided/controller.js';
import { ImplementationCommands } from '../src/execution/implementation-commands.js';
import { taskUsage } from '../src/reporting/task-usage.js';
import { fixture, git, inlineImplementation, services, windows } from './helpers/guided-tasks.js';

test(
  'focused checks and parallel readiness preserve independent review and record every workflow step',
  { ...windows, timeout: 120_000 },
  async t => {
    const f = fixture(t),
      config = services();
    writeFileSync(
      join(f.repo, 'smoke.test.js'),
      "const test=require('node:test'),assert=require('node:assert/strict'),cp=require('node:child_process');\n" +
        "test('greeting',()=>assert.equal(cp.execFileSync(process.execPath,['greeting.js'],{encoding:'utf8'}),'hello world\\n'));\n" +
        "test('unrelated',()=>{throw new Error('The focused diagnostic must filter this test out')});\n",
    );
    git(f.repo, 'add', 'smoke.test.js');
    git(f.repo, 'commit', '-m', 'Add focused regression');
    let reviews = 0;
    const connector = config.connector!;
    config.connector = async (...args) => {
      reviews++;
      const agent = await connector(...args);
      return {
        ...agent,
        turn: async prompt => {
          assert.match(prompt, /Consider an extra edge case/);
          return agent.turn(prompt);
        },
      };
    };
    config.implementationRunner = async options => {
      const result = await inlineImplementation(options, "console.log('hello world');\n");
      const commands = new ImplementationCommands(f.store, options.receipt!.checkId);
      await assert.rejects(commands.run('diagnostic:unit', { files: ['AGENTS.md'] }), /Diagnostic files/);
      const checked = (await commands.run('diagnostic:unit', {
        parameters: { filter: 'greeting' },
        files: ['smoke.test.js'],
      })) as { phase: string };
      assert.equal(checked.phase, 'passed');
      const path = join(options.receipt!.directory, 'result.json');
      const reply = JSON.parse(readFileSync(path, 'utf8'));
      reply.result.reply.findings = [
        { severity: 'suggestion', description: 'Consider an extra edge case', evidence: 'Reviewed smoke.test.js' },
      ];
      writeFileSync(path, JSON.stringify(reply));
      return result;
    };
    const mechanical = (kind: 'lint' | 'types') => ({
      kind,
      name: kind,
      file: 'node',
      args: ['--check', 'greeting.js'],
      timeoutMs: 15000,
    });
    const tasks = new GuidedTasks(f.store, config);
    const task = tasks.create({
      ...f.plan,
      quality: { passes: [] },
      workflowPolicy: { mode: 'automatic' },
      slices: [
        {
          ...f.plan.slices[0],
          readiness: [mechanical('lint'), mechanical('types')],
          readinessConcurrency: 2,
          diagnostics: [
            {
              name: 'unit',
              file: 'node',
              args: ['--test'],
              timeoutMs: 15000,
              selection: { parameters: [{ name: 'filter', flag: '--test-name-pattern' }], fileSuffixes: ['.test.js'] },
            },
          ],
        },
      ],
    });
    tasks.approve(task.id, 1, task.guided!.digest);
    const state = await tasks.run(task.id);
    assert.equal(state.status, 'complete', state.note);
    assert.equal(reviews, 1);
    const children = f.store.checks(state.executionId!).filter(check => check.groupId);
    assert.equal(children.length, 2);
    assert.equal(children[0]!.groupId, children[1]!.groupId);
    const timing = taskUsage(f.store, task.id).workflow!;
    assert.ok(timing.elapsedMs! >= timing.activeMs);
    assert.equal(timing.live, false);
    assert.ok(timing.steps.every(step => step.finishedAt));
    for (const stage of [
      'workspace',
      'implementation',
      'readiness',
      'validation',
      'review',
      'verification',
      'delivery',
    ])
      assert.ok(
        timing.stages.some(row => row.stage === stage && row.steps > 0),
        stage,
      );
  },
);
