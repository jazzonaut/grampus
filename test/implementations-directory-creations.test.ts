// Native-created source must remain covered by the final artifact even when an approved ignore file changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Sessions } from '../src/execution/sessions.js';
import { authorizeEditTool } from '../src/execution/edit-policy.js';
import { fixture, fakeResult, windows } from './helpers/implementations.js';

test('directory creations cannot disappear behind a later approved ignore change', windows, async t => {
  const f = await fixture(t);
  const policy = {
    ...f.policy,
    create: ['.gitignore'],
    directories: [{ path: 'src', actions: ['create' as const], suffixes: ['.ts'] }],
  };
  const result = await f.implementations.run(f.execution.id, policy, 'Create a helper', {}, async options => {
    const context = { cwd: options.cwd, policy, snapshot: f.snapshot };
    const emit = (event: Parameters<Sessions['event']>[2]) => {
      new Sessions(f.store).event(f.execution.sessionId, options.receipt!.checkId, event);
    };
    assert.equal(
      authorizeEditTool(context, 'Write', { file_path: 'src/helper.ts', content: 'export const helper = true;' }, emit)
        .allowed,
      true,
    );
    mkdirSync(join(options.cwd, 'src'));
    writeFileSync(join(options.cwd, 'src', 'helper.ts'), 'export const helper = true;');
    assert.equal(
      authorizeEditTool(context, 'Write', { file_path: '.gitignore', content: 'src/helper.ts\n' }, emit).allowed,
      true,
    );
    writeFileSync(join(options.cwd, '.gitignore'), 'src/helper.ts\n');
    return fakeResult(options);
  });
  assert.equal(result.phase, 'failed', result.error ?? '');
  assert.match(result.error ?? '', /ignored|creation.*snapshot/i);
});
