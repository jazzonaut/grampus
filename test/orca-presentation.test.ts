// Desktop projection tests over real temporary Git worktrees and SQLite journals. The fake desktop
// records only presentation writes; it cannot create provider results or advance the controller.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OrcaCli, type OrcaCard, type OrcaDesktopClient } from '../src/repository/orca.js';
import { OrcaPresentation, orcaCard } from '../src/repository/orca-presentation.js';
import { stopReason } from '../src/orchestration/guided/stop-reasons.js';
import type { GuidedState } from '../src/orchestration/guided/state.js';
import { fixture } from './helpers/orca.js';
import { guidedRecord, planRecord } from './helpers/task-records.js';
import { startUi } from '../src/server/ui-server.js';
import { connect } from './helpers/dashboard.js';

async function desktopFixture(t: { after(fn: () => void | Promise<void>): void }) {
  const f = fixture(t);
  const workspace = await f.workspaces.createOrca(f.task.id, 1, f.repo, 'main');
  const cards: { identity: string; card: OrcaCard }[] = [];
  const opened: { url: string; identity: string | undefined }[] = [];
  let unavailable = false;
  const client: OrcaDesktopClient = {
    show: (repo, identity) => f.client.show(repo, identity),
    setCard: async (_, identity, card) => {
      if (unavailable) throw new Error('Desktop offline');
      cards.push({ identity, card });
    },
    openDashboard: async (_, url, identity) => {
      opened.push({ url, identity });
    },
  };
  const update = (fields: Partial<GuidedState>) =>
    f.store.transaction(() => {
      const task = f.store.get(f.task.id);
      task.guided = {
        ...(task.guided ??
          guidedRecord({
            plan: planRecord({ workspace: { adapter: 'orca', repo: f.repo, base: workspace.baseCommit } }),
            workspaceId: workspace.id,
            status: 'running',
            stage: 'implementation',
            approvedDigest: 'fixture',
          })),
        ...fields,
      };
      f.store.save(task.id, task);
      f.store.append(task.id, task.version, 'fixture.updated', fields);
    });
  update({});
  const presentation = new OrcaPresentation(f.store, client);
  t.after(() => presentation.close());
  return {
    ...f,
    workspace,
    cards,
    opened,
    client,
    update,
    presentation,
    unavailable: (value: boolean) => {
      unavailable = value;
    },
  };
}

test('Orca cards follow journal stages and mark each new attention state once', async t => {
  const f = await desktopFixture(t);
  await f.presentation.sync();
  assert.equal(f.cards[0]?.identity, f.workspace.orca?.identityKey);
  assert.equal(f.cards[0]?.card.status, 'in-progress');
  assert.match(f.cards[0].card.comment, /Implementing/);
  await f.presentation.sync();
  assert.equal(f.cards.length, 1);
  f.update({ stage: 'review' });
  await f.presentation.sync();
  assert.equal(f.cards.at(-1)?.card.status, 'in-review');
  f.update({ status: 'awaiting_answer', stopReason: stopReason('AGENT_QUESTION', 'Choose a greeting') });
  await f.presentation.sync();
  assert.equal(f.cards.at(-1)?.card.attention, true);
  await f.presentation.sync();
  assert.equal(f.cards.length, 3);
  f.update({ status: 'draft', stopReason: stopReason('APPROVAL_REQUIRED', 'Approve the revised plan') });
  await f.presentation.sync();
  assert.equal(f.cards.at(-1)?.card.attention, true);
  assert.match(f.cards.at(-1)!.card.comment, /Approve the revised plan/);
  f.update({ status: 'recovery_required', stopReason: stopReason('SETTLEMENT_UNCONFIRMED', 'Recover the operation') });
  await f.presentation.sync();
  assert.match(f.cards.at(-1)!.card.comment, /Recover the operation/);
});

test('a guided complete flag cannot announce unverified delivery', async t => {
  const f = await desktopFixture(t);
  f.update({ status: 'complete', stage: 'complete' });
  await f.presentation.sync();
  assert.notEqual(f.cards.at(-1)?.card.status, 'completed');
  assert.equal(f.cards.at(-1)?.card.attention, true);
  const task = f.store.get(f.task.id);
  task.phase = 'complete';
  assert.equal(orcaCard(task).status, 'completed');
  task.guided!.pending = {
    stage: 'delivery',
    known: [],
    assessment: null,
    guidance: [],
    controller: { token: 'fixture', host: 'fixture', controllerPid: process.pid, controllerStartedAt: null },
  };
  assert.notEqual(orcaCard(task).status, 'completed');
});

test('desktop failures retain journal truth and recover on a later scan', async t => {
  const f = await desktopFixture(t);
  const revision = f.store.revision();
  f.unavailable(true);
  await f.presentation.sync();
  assert.match(f.presentation.status(f.task.id).problem!, /unavailable/);
  assert.equal(f.store.revision(), revision);
  f.unavailable(false);
  await f.presentation.sync();
  assert.equal(f.cards.length, 1);
  assert.equal(f.presentation.status(f.task.id).problem, null);
  assert.equal(f.store.revision(), revision);
});

test('replacement, archived and mismatched Orca instances receive no card writes or navigation', async t => {
  const f = await desktopFixture(t);
  for (const fields of [{ instanceId: 'replacement' }, { isArchived: true }, { branch: 'refs/heads/other' }]) {
    const original = { ...f.state.worktree };
    Object.assign(f.state.worktree!, fields);
    await f.presentation.sync();
    await assert.rejects(f.presentation.open(f.task.id, 'http://127.0.0.1:4318/#secret'), /changed|identity/);
    f.state.worktree = original;
  }
  assert.deepEqual(f.cards, []);
  assert.deepEqual(f.opened, []);
});

test('a changed journal observation is discarded before a desktop write', async t => {
  const f = await desktopFixture(t);
  const presentation = new OrcaPresentation(f.store, {
    ...f.client,
    show: async (repo, identity) => {
      const observed = await f.client.show(repo, identity);
      f.update({ stage: 'review' });
      return observed;
    },
  });
  await presentation.sync();
  assert.equal(f.cards.length, 0);
  await presentation.close();
});

test('concurrent scans share one operation and shutdown waits for settlement', async t => {
  const f = await desktopFixture(t);
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const presentation = new OrcaPresentation(f.store, {
    ...f.client,
    show: async (repo, identity) => {
      await gate;
      return f.client.show(repo, identity);
    },
  });
  const first = presentation.sync();
  assert.equal(presentation.sync(), first);
  const closed = presentation.close();
  release();
  await closed;
  assert.equal(f.cards.length, 0);
  await presentation.sync();
  assert.equal(f.cards.length, 0);
});

test('desktop writes use explicit identity and never clear unread or send provider input', async () => {
  const calls: string[][] = [];
  const client = new OrcaCli(async (_, args) => {
    calls.push(args);
    if (args[1] === 'list') return JSON.stringify({ ok: true, result: { tabs: [] } });
    return JSON.stringify({ ok: true, result: { browserPageId: 'fixture-page' } });
  });
  await client.setCard('.', 'wt2:local:fixture', {
    title: 'Fixture',
    comment: 'Grampus: Implementing',
    status: 'in-progress',
    attention: false,
  });
  await client.openDashboard('.', 'http://127.0.0.1:4318/#secret', 'wt2:local:fixture');
  assert.ok(calls.every(args => args.includes('identity:wt2:local:fixture')));
  assert.ok(calls.every(args => !args.includes('--read') && !args.includes('send') && !args.includes('launch')));
  assert.ok(calls.at(-1)?.includes('fixture-page'));
  await assert.rejects(client.openDashboard('.', 'https://example.invalid/#secret'), /loopback/);
});

test('Orca navigation is authenticated, bound to the task workspace and independent of workflow state', async t => {
  const f = await desktopFixture(t);
  const ui = await startUi({ db: f.db, port: 0, orca: f.client });
  try {
    const api = connect(ui);
    await ui.orca?.sync();
    const view = await api.task(f.task.id);
    assert.equal(view.orca?.open.id, 'open-orca');
    const path = view.orca.open.request.path;
    const revision = f.store.revision();
    const unauthorised = await fetch(api.origin + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauthorised.status, 401);
    const foreign = await fetch(api.origin + path, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${api.token}`,
        'Content-Type': 'application/json',
        Origin: 'https://example.invalid',
      },
      body: '{}',
    });
    assert.equal(foreign.status, 403);
    assert.equal((await api.post(path, { url: 'https://example.invalid' })).status, 400);
    assert.equal(f.opened.length, 0);
    const response = await api.act(view.orca.open);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, settled: true });
    assert.deepEqual(f.opened, [{ url: `${ui.url}!/tasks/${f.task.id}`, identity: f.workspace.orca?.identityKey }]);
    assert.equal(f.store.revision(), revision);
  } finally {
    await ui.close();
  }
});

test('Orca navigation failures never expose the dashboard access token or modify the task', async t => {
  const f = await desktopFixture(t);
  const ui = await startUi({
    db: f.db,
    port: 0,
    orca: {
      ...f.client,
      openDashboard: async (_, url) => {
        throw new Error(`Failed to open ${url}`);
      },
    },
  });
  try {
    const api = connect(ui);
    await ui.orca?.sync();
    const revision = f.store.revision();
    const response = await api.post(`/api/tasks/${f.task.id}/open-orca`, {});
    assert.equal(response.status, 503);
    assert.ok(!(await response.text()).includes(api.token));
    assert.equal(f.store.revision(), revision);
    const task = f.store.get(f.task.id);
    task.deletedAt = new Date().toISOString();
    f.store.transaction(() => {
      f.store.save(task.id, task);
    });
    assert.equal((await api.post(`/api/tasks/${task.id}/open-orca`, {})).status, 404);
  } finally {
    await ui.close();
  }
});
