import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { runDemo } from '../src/demo.js';
import { Store } from '../src/store.js';
import { Workflow } from '../src/workflow.js';
import { renderReport } from '../src/report.js';

test('CLI create, approve and show persist state across separate invocations', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-cli-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'state with spaces', 'journal.sqlite');
  const brief = join(root, 'brief.json');
  writeFileSync(brief, JSON.stringify({ title: 'CLI case', outcome: 'Persist', criteria: ['Saved'], plan: 'Store' }));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (...args: string[]) => execFileSync(process.execPath, [cli, '--db', db, ...args], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const created = JSON.parse(run('create', brief)) as { id: string };
  run('approve', created.id, '1');
  const shown = JSON.parse(run('show', created.id)) as { task: { phase: string } };
  assert.equal(shown.task.phase, 'ready');
  assert.match(run('report', created.id), /plan.approved/);
});

test('demo reaches completion with explicitly synthetic evidence and retained recovery history', t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-demo-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const db = join(root, 'journal.sqlite');
  const id = runDemo(db);
  const store = new Store(db);
  try {
    const task = new Workflow(store).get(id);
    assert.equal(task.phase, 'complete');
    assert.equal(task.synthetic, true);
    assert.ok(task.evidence.every(item => item.source === 'synthetic'));
    const report = renderReport(store, id);
    assert.match(report, /Synthetic demonstration/);
    assert.match(report, /recovery.required/);
    assert.match(report, /result.ignored/);
  } finally { store.close(); }
});
