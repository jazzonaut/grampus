// Journal writes from several processes at once, as parallel guided tasks make them: the busy timeout lets
// each writer wait for another process's write transaction instead of failing with SQLITE_BUSY, even while
// one holds the write lock as long as a process identity query may take during explicit recovery.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/persistence/store.js';
import { processLimits } from '../src/config/limits.js';
import { taskRecord } from './helpers/task-records.js';

/** Transactions each writer commits after the held one. */
const writes = 150;
/** The longest a writer holds the lock: a whole identity query plus a margin. */
const holdMs = processLimits.identityTimeoutMs + 1000;

test('processes writing one journal at once all commit without busy failures', async t => {
  assert.ok(processLimits.journalBusyMs > holdMs, 'the busy timeout outlasts the longest held write lock');
  const root = mkdtempSync(join(tmpdir(), 'grampus-store-concurrency-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'grampus.sqlite'),
    held = join(root, 'held'),
    program = join(root, 'writer.mjs');
  new Store(db).close();
  // The holder takes the write lock and signals; the others start writing only once it is held, so they
  // must wait for it, and then contend with each other for every transaction.
  writeFileSync(
    program,
    `
    import { existsSync, writeFileSync } from 'node:fs';
    import { Store } from ${JSON.stringify(new URL('../src/persistence/store.js', import.meta.url).href)};
    const [db, id, role] = process.argv.slice(2);
    const store = new Store(db);
    const task = { ...${JSON.stringify(taskRecord('fixture', { version: 0 }))}, id };
    store.transaction(() => { store.save(id, task); store.append(id, 1, 'writer.started', {}); });
    if (role === 'holder')
      store.transaction(() => {
        writeFileSync(${JSON.stringify(held)}, '');
        for (const until = Date.now() + ${holdMs}; Date.now() < until; );
        store.append(id, 1, 'writer.held', {});
      });
    else while (!existsSync(${JSON.stringify(held)})) await new Promise(resolve => setTimeout(resolve, 5));
    for (let i = 1; i <= ${writes}; i++)
      store.transaction(() => {
        store.save(id, { ...store.get(id), version: i });
        store.append(id, 1, 'writer.wrote', { i });
      });
    store.close();
  `,
  );
  const writers = ['holder', 'first', 'second'].map(
    role =>
      new Promise<{ role: string; code: number | null; stderr: string }>(resolve => {
        const child = spawn(process.execPath, [program, db, `task-${role}`, role], {
          windowsHide: true,
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
        child.on('close', code => resolve({ role, code, stderr }));
      }),
  );
  for (const result of await Promise.all(writers)) assert.equal(result.code, 0, `${result.role}: ${result.stderr}`);
  const store = new Store(db);
  try {
    for (const role of ['holder', 'first', 'second']) {
      const id = `task-${role}`;
      assert.equal(store.get(id).version, writes);
      assert.equal(store.events(id, ['writer.wrote']).length, writes);
    }
  } finally {
    store.close();
  }
});
