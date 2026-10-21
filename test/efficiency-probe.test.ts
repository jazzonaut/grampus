// The benchmark uses separate real Git clones and supervised commands; a passing agent exit is not verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { efficiencyBenchmark } from '../src/probes/efficiency-probe.js';

test(
  'comparison arms share a pinned base but verify independently in separate retained clones',
  { skip: process.platform !== 'win32' },
  async t => {
    const root = mkdtempSync(join(tmpdir(), 'grampus-benchmark-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: 'pipe', windowsHide: true }).trim();
    git('init');
    git('config', 'user.name', 'Fixture');
    git('config', 'user.email', 'fixture@invalid');
    writeFileSync(join(root, 'value.txt'), 'baseline');
    git('add', '.');
    git('commit', '-m', 'Baseline');
    const command = (code: string) => ({ file: 'node', args: ['-e', code], timeoutMs: 15000 });
    const result = await efficiencyBenchmark(
      {
        repository: root,
        base: 'HEAD',
        repetitions: 1,
        setup: [],
        verify: [
          command("require('node:assert/strict').equal(require('node:fs').readFileSync('value.txt','utf8'),'correct')"),
        ],
        arms: ['direct', 'direct_with_gates', 'grampus'].map(name => ({
          name,
          resultDirectory: '.',
          commands: [
            command(
              `require('node:fs').writeFileSync('value.txt',${JSON.stringify(name === 'direct' ? 'wrong' : 'correct')})`,
            ),
          ],
        })),
      },
      root,
    );
    assert.equal(result.rows.length, 3);
    assert.equal(result.rows[0]?.implementation?.passed, true);
    assert.equal(result.rows[0]?.verification?.passed, false);
    assert.equal(result.rows[1]?.verification?.passed, true);
    assert.equal(result.rows[2]?.verification?.passed, true);
    assert.equal(readFileSync(join(root, 'value.txt'), 'utf8'), 'baseline');
    assert.equal(new Set(result.rows.map(row => row.output)).size, 3);
    assert.ok(readFileSync(join(result.root, 'result.json'), 'utf8').includes(result.base));
  },
);
