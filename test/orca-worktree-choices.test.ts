// New task's Orca repository folder choices: local worktrees across repositories, grouped by repository so
// two worktrees both called `main` stay distinguishable, archived and remote rows left out, a partial listing
// counted, and an absent or failing Orca withdrawing the choice instead of failing the route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { startUi } from '../src/server/ui-server.js';
import { OrcaCli, type OrcaTransport } from '../src/repository/orca.js';
import type { OrcaWorktreesV1 } from '../src/server/api-types.js';
import { fixture } from './helpers/guided-tasks.js';

const root = join(tmpdir(), 'grampus-orca-choices');

function row(repoId: string, folder: string, name: string, branch: string, extra: Record<string, unknown> = {}) {
  const instanceId = `${repoId}-${name}`;
  const path = join(root, folder);
  return {
    id: `${repoId}::${path}`,
    repoId,
    path,
    branch: `refs/heads/${branch}`,
    displayName: name,
    hostId: 'local',
    instanceId,
    identity: { key: `wt2:local:${instanceId}`, instanceId, executionHostId: 'local' },
    isMainWorktree: name === 'main',
    isArchived: false,
    ...extra,
  };
}

async function choices(
  t: { after(fn: () => void | Promise<void>): void },
  orca: OrcaCli | undefined,
): Promise<OrcaWorktreesV1> {
  const cleanups: (() => void)[] = [];
  const f = fixture({ after: fn => cleanups.push(fn) });
  const ui = await startUi({ db: f.store.path, port: 0, ...(orca ? { orca } : {}) });
  t.after(async () => {
    await ui.close();
    for (const cleanup of cleanups) cleanup();
  });
  const url = new URL(ui.url);
  const response = await fetch(`${url.origin}/api/v1/orca-worktrees`, {
    headers: { Authorization: `Bearer ${url.hash.slice(1)}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as OrcaWorktreesV1;
}

test('local worktrees are grouped by repository with full paths, main first', async t => {
  const requests: string[][] = [];
  const run: OrcaTransport = async (_cwd, args) => {
    requests.push(args);
    const worktrees = [
      row('repo-b', 'grampus', 'main', 'main'),
      row('repo-b', 'grampus-fix', 'fix', 'feature/fix'),
      row('repo-a', 'other', 'main', 'main'),
      row('repo-a', 'other-old', 'old', 'old', { isArchived: true }),
      { ...row('repo-a', 'remote', 'remote', 'remote'), hostId: 'runtime:x' },
    ];
    return JSON.stringify({
      ok: true,
      result: {
        worktrees,
        totalCount: worktrees.length + 2,
        truncated: true,
        hostScope: { hostIds: ['local'], omittedHostIds: ['runtime:x'] },
      },
    });
  };
  const view = await choices(t, new OrcaCli(run));
  assert.deepEqual(requests, [['worktree', 'list', '--limit', '100', '--json']]);
  assert.equal(view.available, true);
  assert.equal(view.omitted, 2);
  assert.deepEqual(view.repositories, [
    {
      name: 'grampus',
      worktrees: [
        { path: normalize(join(root, 'grampus')), label: 'main' },
        { path: normalize(join(root, 'grampus-fix')), label: 'fix (feature/fix)' },
      ],
    },
    { name: 'other', worktrees: [{ path: normalize(join(root, 'other')), label: 'main' }] },
  ]);
});

test('without Orca, or when Orca refuses, the choice is withdrawn', async t => {
  assert.deepEqual(await choices(t, undefined), { apiVersion: 1, available: false, repositories: [], omitted: 0 });
  const refused = new OrcaCli(async () => JSON.stringify({ ok: false, error: { code: 'runtime_unavailable' } }));
  assert.equal((await choices(t, refused)).available, false);
  const offline = new OrcaCli(async () => {
    throw new Error('Orca command failed or timed out; its host outcome may be unknown');
  });
  assert.equal((await choices(t, offline)).available, false);
});
