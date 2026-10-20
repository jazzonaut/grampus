// Pins supervisor startup isolation from the dashboard's inherited working directory.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readReceipt } from '../src/verification/check-recovery.js';
import { fixture, windows } from './helpers/checks.js';

test('checks compile their supervisor outside the controller working directory', windows, async t => {
  const f = await fixture(t);
  const controllerDirectory = join(f.root, 'controller');
  mkdirSync(controllerDirectory);
  // PowerShell 7's directory contains a System.dll incompatible with Windows PowerShell.
  // An invalid assembly recreates its reference-shadowing failure without requiring PowerShell 7.
  writeFileSync(join(controllerDirectory, 'System.dll'), 'Not a .NET Framework assembly');
  const spec = await f.spec('console.log(process.cwd())');
  const storeModule = JSON.stringify(new URL('../src/persistence/store.js', import.meta.url).href);
  const checksModule = JSON.stringify(new URL('../src/verification/checks.js', import.meta.url).href);
  const code = `
    import { Store } from ${storeModule};
    import { Checks } from ${checksModule};
    const store = new Store(${JSON.stringify(f.db)});
    try {
      const check = await new Checks(store).run(${JSON.stringify(f.execution.id)}, ${JSON.stringify(spec)});
      console.log(check.id);
    } finally { store.close(); }
  `;
  const id = execFileSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: controllerDirectory,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const check = f.checks.get(id);
  assert.equal(check.phase, 'passed', JSON.stringify(check.result));
  assert.equal(check.result?.exitConfirmed, true);
  assert.equal(check.result.stdout.trim(), f.workspace.path);
  assert.ok(check.receipt);
  assert.equal(readReceipt(check.receipt, check.supervisorPid, check.toolPid).reason, 'exited');
  assert.equal(f.store.lease(f.workspace.id), null);
});
