// Real child dashboards and SQLite journals prove cross-process start-or-reconnect, crash recovery
// and conservative handling of an unavailable live owner. No provider is started by the fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ensureDesktop } from '../src/server/desktop-launch.js';
import {
  desktopFiles,
  desktopProfile,
  desktopRequest,
  desktopResponds,
  publishDesktopEndpoint,
  readDesktopEndpoint,
  type DesktopProfile,
} from '../src/server/desktop-discovery.js';

function fixture(t: { after(fn: () => void | Promise<void>): void }) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-desktop-'));
  const profile = desktopProfile(root, join(root, 'journal.sqlite'));
  const entry = join(root, 'server.mjs');
  const url = (module: string) => new URL(`../src/server/${module}.js`, import.meta.url).href;
  writeFileSync(
    entry,
    `
    import {parseArgs} from 'node:util'; import {appendFileSync} from 'node:fs';
    import {startUi} from ${JSON.stringify(url('ui-server'))};
    import {awaitDesktopPermit} from ${JSON.stringify(url('desktop-launch'))};
    import {desktopProfile} from ${JSON.stringify(url('desktop-discovery'))};
    const {values}=parseArgs({allowPositionals:true,options:{db:{type:'string'},port:{type:'string'},background:{type:'boolean'},'no-open':{type:'boolean'}}});
    await awaitDesktopPermit(); appendFileSync(${JSON.stringify(join(root, 'starts'))},${JSON.stringify('start\n')});
    await startUi({db:values.db,port:Number(values.port),desktop:desktopProfile(${JSON.stringify(root)},values.db)});
  `,
  );
  t.after(async () => {
    const endpoint = readDesktopEndpoint(profile);
    if (endpoint && (await desktopResponds(endpoint))) {
      await desktopRequest(endpoint, true);
      const until = Date.now() + 10_000;
      while (existsSync(desktopFiles(profile).receipt) && Date.now() < until)
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    rmSync(root, { recursive: true, force: true });
  });
  return { root, profile, entry, port: 0 };
}

test('concurrent opens start one real dashboard and later opens authenticate the same instance', async t => {
  const f = fixture(t);
  const [first, simultaneous] = await Promise.all([ensureDesktop(f), ensureDesktop(f)]);
  assert.equal(first.endpoint.instance, simultaneous.endpoint.instance);
  assert.equal(first.started, true);
  const next = await ensureDesktop(f);
  assert.equal(next.started, false);
  assert.equal(next.endpoint.pid, first.endpoint.pid);
  assert.equal(readFileSync(join(f.root, 'starts'), 'utf8'), 'start\n');
  assert.ok(existsSync(f.profile.db));
  const unauthorised = await fetch(`${new URL(first.endpoint.url!).origin}/api/desktop`);
  assert.equal(unauthorised.status, 401);
});

async function childLauncher(profile: DesktopProfile, entry: string): Promise<{ pid: number }> {
  const module = new URL('../src/server/desktop-launch.js', import.meta.url).href;
  const script = `import {ensureDesktop} from ${JSON.stringify(module)};
    const result=await ensureDesktop(${JSON.stringify({ profile, entry, port: 0 })});
    console.log(JSON.stringify({pid:result.endpoint.pid}));`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true });
    let output = '',
      error = '';
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      error += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', code =>
      code === 0 ? resolve(JSON.parse(output) as { pid: number }) : reject(new Error(error)),
    );
  });
}

test('independent launcher processes serialise startup and converge on the same dashboard', async t => {
  const f = fixture(t);
  const results = await Promise.all([childLauncher(f.profile, f.entry), childLauncher(f.profile, f.entry)]);
  assert.equal(results[0].pid, results[1].pid);
  assert.equal(readFileSync(join(f.root, 'starts'), 'utf8'), 'start\n');
});

test('a live or uncertain starting process is never relaunched', async t => {
  const f = fixture(t);
  publishDesktopEndpoint(f.profile, null);
  await assert.rejects(ensureDesktop(f), /not restarted/);
  assert.equal(existsSync(join(f.root, 'starts')), false);
});

test('a provably exited dashboard may be replaced without touching its journal', async t => {
  const f = fixture(t);
  const pid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { windowsHide: true }));
  publishDesktopEndpoint(f.profile, null, pid);
  const result = await ensureDesktop(f);
  assert.equal(result.started, true);
  assert.notEqual(result.endpoint.pid, pid);
});

test('foreign, malformed and non-loopback receipts are refused before using their access link', async t => {
  const f = fixture(t);
  const endpoint = publishDesktopEndpoint(f.profile, null);
  for (const value of [
    { ...endpoint, url: 'https://example.invalid/#secret' },
    { ...endpoint, db: 'another-journal' },
    { ...endpoint, schema: 0 },
    {},
  ]) {
    writeFileSync(desktopFiles(f.profile).receipt, JSON.stringify(value));
    await assert.rejects(ensureDesktop(f), /discovery is invalid/);
  }
  writeFileSync(desktopFiles(f.profile).receipt, JSON.stringify(endpoint));
  assert.equal(existsSync(join(f.root, 'starts')), false);
});
