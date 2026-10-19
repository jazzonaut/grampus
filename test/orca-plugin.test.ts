// Executes the actual plugin worker entry with isolated Node launchers, never a developer runtime.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { OrcaCli } from '../src/repository/orca.js';

async function pluginFixture(t: { after(fn: () => void): void }, source?: string) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-plugin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const launcher = join(root, 'launcher.mjs');
  const record = join(root, 'calls.json');
  writeFileSync(
    launcher,
    source ??
      `import {writeFileSync} from 'node:fs';
    writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));
    await new Promise(resolve=>setTimeout(resolve,50)); console.log(JSON.stringify({ok:true}));`,
  );
  const entry = join(root, 'main.mjs');
  copyFileSync(fileURLToPath(new URL('../../plugins/orca/main.mjs', import.meta.url)), entry);
  writeFileSync(
    join(root, 'launch.json'),
    JSON.stringify({
      schema: 1,
      node: process.execPath,
      launcher,
      orca: process.execPath,
      timeoutMs: 10_000,
      outputBytes: 16_384,
    }),
  );
  const module = await import(pathToFileURL(entry).href);
  const commands = new Map<string, () => Promise<unknown>>();
  module.default({
    commands: { register: (name: string, handler: () => Promise<unknown>) => commands.set(name, handler) },
  });
  return { root, commands, record };
}

test('native plugin commands launch without a shell and repeated opens share one request', async t => {
  const f = await pluginFixture(t);
  const open = f.commands.get('open')!;
  const one = open(),
    two = open();
  assert.equal(one, two);
  await assert.rejects(f.commands.get('stop')!(), /still running/);
  assert.deepEqual(await one, { ok: true });
  assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')), ['open', '--orca']);
  await f.commands.get('stop')!();
  assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')), ['close']);
});

test('plugin process failures expose no raw output or local access link', async t => {
  const secret = 'http://127.0.0.1:4318/#' + 'a'.repeat(64);
  const f = await pluginFixture(t, `console.error(${JSON.stringify(secret)});process.exitCode=1;`);
  const error = await f.commands.get('open')!().catch((error: unknown) => error);
  assert.ok(error instanceof Error);
  assert.ok(!error.message.includes(secret));
  assert.match(error.message, /did not complete/);
});

test(
  'Windows plugin commands restore application data paths stripped by Orca',
  { skip: process.platform !== 'win32' },
  async t => {
    const f = await pluginFixture(t);
    const expected = { APPDATA: process.env.APPDATA, LOCALAPPDATA: process.env.LOCALAPPDATA };
    writeFileSync(
      join(f.root, 'launcher.mjs'),
      `import {writeFileSync} from 'node:fs';
    if(!process.env.APPDATA || !process.env.LOCALAPPDATA) {
      console.error('APPDATA is not set, so the Orca runtime metadata path cannot be resolved.');process.exitCode=1;
    } else {
      writeFileSync(${JSON.stringify(f.record)},JSON.stringify({APPDATA:process.env.APPDATA,LOCALAPPDATA:process.env.LOCALAPPDATA}));
      console.log(JSON.stringify({ok:true}));
    }`,
    );
    // Orca's real worker allowlist preserves USERPROFILE/SystemRoot, but removes both app data variables.
    delete process.env.APPDATA;
    delete process.env.LOCALAPPDATA;
    t.after(() => {
      for (const [key, value] of Object.entries(expected)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    assert.deepEqual(await f.commands.get('open')!(), { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')), expected);
    process.env.APPDATA = join(f.root, 'explicit-roaming');
    assert.deepEqual(await f.commands.get('open')!(), { ok: true });
    assert.deepEqual(JSON.parse(readFileSync(f.record, 'utf8')), {
      APPDATA: process.env.APPDATA,
      LOCALAPPDATA: expected.LOCALAPPDATA,
    });
  },
);

test('opening Grampus reuses and reauthenticates its exact Orca browser page', async () => {
  const calls: string[][] = [];
  const cli = new OrcaCli(async (_, args) => {
    calls.push(args);
    return JSON.stringify({
      ok: true,
      result: { tabs: [{ browserPageId: 'dashboard-page', url: 'http://127.0.0.1:4318/#/tasks/abc' }] },
    });
  });
  await cli.openDashboard('.', 'http://127.0.0.1:4318/#' + 'a'.repeat(64));
  assert.deepEqual(
    calls.map(args => args[0]),
    ['tab', 'goto', 'tab'],
  );
  assert.ok(calls[1]!.includes('dashboard-page'));
  assert.ok(calls[2]!.includes('--focus'));
  assert.ok(calls.every(args => !args.includes('create')));
});

test('an unrecognised Orca tab listing cannot trigger duplicate navigation', async () => {
  const calls: string[][] = [];
  const cli = new OrcaCli(async (_, args) => {
    calls.push(args);
    return '{"ok":true,"result":{}}';
  });
  await assert.rejects(cli.openDashboard('.', 'http://127.0.0.1:4318/#' + 'a'.repeat(64)), /tab list/);
  assert.equal(calls.length, 1);
});
