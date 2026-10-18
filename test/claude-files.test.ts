import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { claudeDeleteTool } from '../src/agents/claude-files.js';
import type { EditingContext } from '../src/edit-policy.js';
import type { AgentEvent } from '../src/agents/types.js';

function fixture(t: { after(fn: () => void): void }) {
  const cwd = mkdtempSync(join(tmpdir(), 'grampus-claude-delete-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, 'obsolete.txt');
  writeFileSync(path, 'obsolete\n');
  const artifact = `sha256:${'a'.repeat(64)}`,
    instructionsDigest = 'b'.repeat(64);
  const context: EditingContext = {
    cwd,
    policy: { artifact, instructionsDigest, files: [], delete: ['obsolete.txt'] },
    snapshot: {
      artifact,
      instructionsDigest,
      head: 'fixture',
      index: '',
      diff: [],
      instructions: [],
      files: [
        { path: 'obsolete.txt', sha256: createHash('sha256').update('obsolete\n').digest('hex'), executable: false },
      ],
    },
  };
  return { cwd, path, context };
}

test('Claude deletion tool only unlinks during its owning active turn and rejects repeated requests', async t => {
  const f = fixture(t);
  let active = false;
  const events: AgentEvent[] = [];
  const tool = claudeDeleteTool(
    f.context,
    event => events.push(event),
    () => active,
  );
  const call = () => tool.handler({ file_path: 'obsolete.txt' }, undefined);
  assert.equal((await call()).isError, true);
  assert.equal(existsSync(f.path), true);
  assert.equal(events.length, 0);
  active = true;
  assert.equal((await call()).isError, undefined);
  assert.equal(existsSync(f.path), false);
  assert.deepEqual(
    events.map(event => event.type),
    ['tool.authorized', 'tool.deleted'],
  );
  assert.equal((await call()).isError, true);
  writeFileSync(f.path, 'obsolete\n');
  active = false;
  assert.equal((await call()).isError, true);
  assert.equal(existsSync(f.path), true);
});

test('Claude deletion handler rechecks the actual policy and journal even if permission hooks were bypassed', async t => {
  const f = fixture(t);
  const tool = claudeDeleteTool(
    f.context,
    () => {},
    () => true,
  );
  assert.equal((await tool.handler({ file_path: 'outside.txt' }, undefined)).isError, true);
  assert.equal(
    (await tool.handler({ file_path: 'obsolete.txt', recursive: true } as { file_path: string }, undefined)).isError,
    true,
  );
  const unavailable = claudeDeleteTool(
    f.context,
    () => {
      throw new Error('Journal unavailable');
    },
    () => true,
  );
  assert.equal((await unavailable.handler({ file_path: 'obsolete.txt' }, undefined)).isError, true);
  assert.equal(readFileSync(f.path, 'utf8'), 'obsolete\n');
  writeFileSync(f.path, 'changed');
  assert.equal((await tool.handler({ file_path: 'obsolete.txt' }, undefined)).isError, true);
  assert.equal(readFileSync(f.path, 'utf8'), 'changed');
});
