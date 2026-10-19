// Stall detection: silent running sessions and checks of guided tasks are surfaced once per silence with
// an injected clock, and nothing is stopped or changed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Store } from '../src/persistence/store.js';
import { StallWatchdog, stallEventType } from '../src/health/stalls.js';
import type { Execution, RepositoryCheck, Session } from '../src/persistence/records.js';

const threshold = 600_000;

function fixture(t: { after: (fn: () => void) => void }, status = 'running') {
  const root = mkdtempSync(join(tmpdir(), 'grampus-stalls-'));
  const store = new Store(join(root, 'grampus.sqlite'));
  t.after(() => {
    store.close();
    rmSync(root, { recursive: true, force: true });
  });
  const taskId = randomUUID(),
    workspaceId = randomUUID(),
    executionId = randomUUID();
  const session: Session = {
    id: randomUUID(),
    provider: 'codex',
    runtime: { executable: null, source: 'path', version: null, sdkVersion: null },
    providerSessionId: 'thread-1',
    model: null,
    cwd: root,
    phase: 'running',
    lastReply: null,
    run: null,
  };
  const task = { id: taskId, version: 2, brief: { title: 'Fixture' }, guided: { status, stage: 'implementation' } };
  store.transaction(() => {
    store.save(taskId, task);
    store.saveWorkspace(workspaceId, taskId, workspaceId, { id: workspaceId } as never);
    store.saveSession(session.id, session);
    const execution: Execution = {
      sliceIndex: 0,
      id: executionId,
      taskId,
      version: 2,
      attemptId: 'attempt',
      workspaceId,
      sessionId: session.id,
      role: 'implementation',
      phase: 'open',
      headAtCreation: 'head',
      artifact: null,
      fallbackReason: null,
    };
    store.saveExecution(executionId, taskId, workspaceId, session.id, execution);
    store.appendSession(session.id, 'turn.started', { runId: 'run' });
  });
  const lastEvent = () => Date.parse(store.sessionEvents(session.id).at(-1)!.at);
  return { root, store, taskId, executionId, session, task, lastEvent };
}

test('a silent running session is surfaced once per silence and resumes clear it, without changing state', t => {
  const f = fixture(t);
  let now = f.lastEvent() + threshold - 1;
  const watchdog = new StallWatchdog(f.store, () => now);
  assert.equal(watchdog.scan(threshold).size, 0, 'below the threshold nothing is reported');
  assert.equal(f.store.events(f.taskId, [stallEventType]).length, 0);
  now = f.lastEvent() + threshold;
  const stall = watchdog.scan(threshold).get(f.taskId);
  assert.deepEqual(stall, {
    since: new Date(now).toISOString(),
    lastActivityAt: new Date(f.lastEvent()).toISOString(),
    owner: { kind: 'session', id: f.session.id, label: 'codex' },
  });
  assert.deepEqual(watchdog.stall(f.taskId), stall);
  const events = f.store.events(f.taskId, [stallEventType]);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.version, 2);
  assert.match(
    (events[0]?.data as { note: string }).note,
    /No activity from the Codex session for 10 min\. Nothing was stopped/,
  );
  now += threshold;
  watchdog.scan(threshold);
  assert.equal(f.store.events(f.taskId, [stallEventType]).length, 1, 'the same silence is not repeated');
  // Any journaled session event is activity: output, usage or tool events alike.
  f.store.appendSession(f.session.id, 'usage.updated', { runId: 'run', data: {} });
  now = f.lastEvent() + 1;
  assert.equal(watchdog.scan(threshold).size, 0);
  assert.equal(watchdog.stall(f.taskId), null);
  now = f.lastEvent() + threshold;
  watchdog.scan(threshold);
  assert.equal(f.store.events(f.taskId, [stallEventType]).length, 2, 'a new silence is reported again');
  // Observation only: the session still runs and the task record is untouched.
  assert.equal(f.store.session(f.session.id).phase, 'running');
  assert.deepEqual(f.store.get(f.taskId), f.task);
});

test('tasks that are not running and settled sessions are never reported', t => {
  const waiting = fixture(t, 'awaiting_answer');
  const now = waiting.lastEvent() + threshold * 2;
  assert.equal(new StallWatchdog(waiting.store, () => now).scan(threshold).size, 0);
  const settled = fixture(t);
  settled.store.saveSession(settled.session.id, { ...settled.session, phase: 'idle' });
  assert.equal(new StallWatchdog(settled.store, () => settled.lastEvent() + threshold).scan(threshold).size, 0);
});

test('a running check counts its growing output logs as activity', t => {
  const f = fixture(t);
  f.store.saveSession(f.session.id, { ...f.session, phase: 'idle' });
  const receipt = join(f.root, 'run-1');
  mkdirSync(receipt);
  const check = {
    id: randomUUID(),
    executionId: f.executionId,
    phase: 'running',
    spec: { name: 'npm test' },
    receipt: { directory: receipt, token: 'token', checkId: 'check' },
  } as unknown as RepositoryCheck;
  f.store.transaction(() => {
    f.store.saveCheck(check.id, f.executionId, check);
    f.store.appendExecution(f.executionId, 'check.process_started', { checkId: check.id });
  });
  const started = Date.parse(f.store.executionEvents(f.executionId).at(-1)!.at);
  const output = join(receipt, 'stdout');
  writeFileSync(output, 'still testing\n');
  const written = started + threshold / 2;
  utimesSync(output, written / 1000, written / 1000);
  let now = started + threshold;
  const watchdog = new StallWatchdog(f.store, () => now);
  assert.equal(watchdog.scan(threshold).size, 0, 'output written after the last event is activity');
  now = written + threshold + 1000; // File times may round; stay clear of the boundary.
  assert.deepEqual(watchdog.scan(threshold).get(f.taskId)?.owner, { kind: 'check', id: check.id, label: 'npm test' });
  assert.match(
    (f.store.events(f.taskId, [stallEventType])[0]?.data as { note: string }).note,
    /No activity from the check npm test/,
  );
});
