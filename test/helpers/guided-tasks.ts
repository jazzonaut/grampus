// Shared fixtures for the guided task tests: an offline repository, services and crash programs.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../../src/persistence/store.js';
import { GuidedTasks } from '../../src/orchestration/guided/controller.js';
import type { GuidedServices } from '../../src/orchestration/guided/state.js';
import { runCheckProcess } from '../../src/process/check-process.js';
import type { Reply } from '../../src/providers/types.js';

export const windows = { skip: process.platform !== 'win32' };

export const cli = fileURLToPath(new URL('../../src/cli.js', import.meta.url));

export const message: Reply = { kind: 'message', text: 'Offline fixture implementation', questions: [], findings: [] };

export const review: Reply = { kind: 'review', text: 'Offline fixture review', questions: [], findings: [] };

export function preparation(code: string) {
  return { name: 'Restore repository prerequisites', file: 'node', args: ['-e', code], timeoutMs: 15000 };
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
}

export function services(source = "console.log('hello world');\n", reply: Reply = message): GuidedServices {
  return {
    implementationRunner: options =>
      runCheckProcess({
        ...options,
        args: [
          '-e',
          `
      const fs = require('node:fs'); fs.writeFileSync('greeting.js', ${JSON.stringify(source)});
      fs.writeFileSync(${JSON.stringify(join(options.receipt!.directory, 'result.json'))}, JSON.stringify({id:${JSON.stringify(options.receipt!.checkId)},
        result:{status:'completed',reply:${JSON.stringify(reply)},usage:null,error:null}}));
    `,
        ],
      }),
    connector: async (_, options) => ({
      turn: async () => {
        options.emit({
          type: 'session.connected',
          data: { providerSessionId: 'offline-guided-review', model: 'fixture' },
        });
        return { status: 'completed', reply: review, usage: null, error: null };
      },
      interrupt: async () => {},
      close: async () => {},
    }),
  };
}

export function fixture(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-guided-')),
    repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@invalid');
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n");
  writeFileSync(join(repo, 'AGENTS.md'), 'Use one direct output statement.\n');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Fixture baseline');
  const store = new Store(join(root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const plan = {
    workflowPolicy: { mode: 'supervised' },
    brief: {
      title: 'Guided greeting',
      outcome: 'Print hello world',
      criteria: ['Print hello world with a newline'],
      plan: 'Edit, validate, simplify, review, verify and deliver locally',
    },
    workspace: { repo, path: join(root, 'workspace'), base: 'HEAD' },
    implementation: { provider: 'codex' },
    slices: [
      {
        scope: { files: ['greeting.js'] },
        validation: {
          file: 'node',
          args: [
            '-e',
            "const a=require('node:assert/strict');const {execFileSync}=require('node:child_process');a.equal(execFileSync(process.execPath,['greeting.js'],{encoding:'utf8'}),'hello world\\n');console.log('validated');",
          ],
          timeoutMs: 15000,
        },
        acceptance: { file: 'node', args: ['greeting.js'], expectedStdout: 'hello world\n', timeoutMs: 15000 },
        message: 'Implement guided greeting',
      },
    ],
  };
  const tasks = new GuidedTasks(store, services());
  const create = () => {
    const task = tasks.create(plan);
    tasks.approve(task.id, 1, task.guided!.digest);
    return task.id;
  };
  return { root, repo, store, plan, tasks, create };
}

export function crashProgram(
  f: ReturnType<typeof fixture>,
  action: 'authorize' | 'assess',
  nextStage: string,
  id: string,
  journalFailure = false,
): void {
  const file = join(f.root, `crash-${nextStage}.mjs`);
  const url = (name: string) => JSON.stringify(new URL(`../../src/${name}.js`, import.meta.url).href);
  writeFileSync(
    file,
    `
    import {join} from 'node:path'; import {Store} from ${url('persistence/store')}; import {GuidedTasks} from ${url('orchestration/guided/controller')}; import {runCheckProcess} from ${url('process/check-process')};
    const message = ${JSON.stringify(message)}, review = ${JSON.stringify(review)};
    const serviceFactory = ${services.toString()};
    const store = new Store(${JSON.stringify(f.store.path)}); const append = store.append.bind(store);
    let failed = false;
    store.append = (id, version, type, data) => {
      if (!failed && type === 'guided.step_finished' && data.stage === ${JSON.stringify(nextStage)}) {
        failed = true;
        if (${journalFailure}) throw new Error('Injected guided journal failure');
        process.exit(29);
      }
      append(id, version, type, data);
    };
    const tasks = new GuidedTasks(store, serviceFactory());
    if (${JSON.stringify(nextStage)} === 'assessment_input') tasks.drive = async () => process.exit(29);
    const result = await tasks.${action}(${JSON.stringify(id)}${action === 'assess' ? ", 'passed', 'Offline explicit simplification'" : ''});
    if (${journalFailure} && result.status === 'recovery_required' && result.pending?.stage === 'delivery') process.exit(29);
    if (${journalFailure} && failed) throw new Error('Verified delivery lost its pending recovery intent: ' + result.status);
    throw new Error('Fault injection was not reached');
  `,
  );
  assert.throws(
    () => execFileSync(process.execPath, [file], { windowsHide: true, stdio: 'pipe' }),
    (error: unknown) => (error as { status: number }).status === 29,
  );
}
