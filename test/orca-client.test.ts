// The Orca CLI client against a stand-in executable that prints canned envelopes and records its arguments.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OrcaCli, OrcaError, OrcaUncertainError } from '../src/orca/client.js';
import { useTestSettings } from './helpers/task-fixture.js';

/**
 * A fake `orca` that appends its argv to a log and prints `response`, or the response for its
 * subcommand (e.g. `worker-show`) when given a map.
 */
function fakeOrca(
  response: string | Record<string, string>,
  exitCode = 0,
): { client: OrcaCli; calls: () => string[][] } {
  const responses = typeof response === 'string' ? { '*': response } : response;
  const dir = mkdtempSync(join(tmpdir(), 'grampus-orca-'));
  const log = join(dir, 'calls.jsonl');
  const script = join(dir, 'orca.mjs');
  writeFileSync(
    script,
    `import { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
const responses = ${JSON.stringify(responses)};
process.stdout.write(responses[process.argv[3]] ?? responses['*']);
process.exit(${exitCode});\n`,
  );
  return {
    client: new OrcaCli([process.execPath, script]),
    calls: () =>
      readFileSync(log, 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as string[]),
  };
}

test('mutations carry the caller request id and parse the result', async () => {
  useTestSettings();
  const { client, calls } = fakeOrca(JSON.stringify({ ok: true, result: { task: { id: 'task_1', status: 'ready' } } }));
  assert.equal(await client.createTask({ runId: 'run_1', title: 'T', spec: 'S', deps: ['task_0'] }, 'req-1'), 'task_1');
  assert.deepEqual(calls()[0], [
    'orchestration',
    'task-create',
    '--run',
    'run_1',
    '--task-title',
    'T',
    '--spec',
    'S',
    '--deps',
    '["task_0"]',
    '--retry-request',
    'req-1',
    '--json',
  ]);
});

test('worker-start passes the launch choice and reads a non-ready receipt despite a non-zero exit', async () => {
  useTestSettings();
  const receipt = { taskId: 'task_1', dispatchId: 'dispatch_1', state: 'outcome_unknown', lastError: 'no turn start' };
  const { client, calls } = fakeOrca(JSON.stringify({ ok: true, result: receipt }), 1);
  const result = await client.startWorker(
    {
      runId: 'run_1',
      taskId: 'task_1',
      worktree: 'current',
      assignment: { agent: 'codex', model: 'gpt-x', effort: 'high' },
      retryOf: 'dispatch_0',
    },
    'req-2',
  );
  assert.equal(result.state, 'outcome_unknown');
  assert.deepEqual(calls()[0]?.slice(2), [
    '--run',
    'run_1',
    '--task',
    'task_1',
    '--worktree',
    'current',
    '--agent',
    'codex',
    '--model',
    'gpt-x',
    '--effort',
    'high',
    '--retry-of',
    'dispatch_0',
    '--retry-request',
    'req-2',
    '--json',
  ]);
});

test('an Orca error envelope is a refusal and missing JSON is uncertain', async () => {
  useTestSettings();
  const refused = fakeOrca(
    JSON.stringify({ ok: false, error: { code: 'task_not_startable', message: 'blocked', data: { dispatchId: 'd' } } }),
    1,
  );
  await assert.rejects(
    refused.client.resolveGate('gate_1', 'approve', 'req-3'),
    (error: unknown) => error instanceof OrcaError && error.code === 'task_not_startable',
  );
  const garbled = fakeOrca('Segmentation fault', 139);
  await assert.rejects(garbled.client.createRun('objective', 'req-4'), OrcaUncertainError);
});

test('check returns the delivery and acknowledges the previous one', async () => {
  useTestSettings();
  const message = {
    id: 'msg_1',
    subject: 'done',
    body: 'b',
    type: 'worker_done',
    payload: '{"outcome":"succeeded"}',
    created_at: 'now',
  };
  const { client, calls } = fakeOrca(
    JSON.stringify({ ok: true, result: { deliveryId: 'delivery_1', messages: [message], count: 1 } }),
  );
  const delivery = await client.check('run_1', { waitMs: 50, ack: 'delivery_0' });
  assert.equal(delivery.deliveryId, 'delivery_1');
  assert.equal(delivery.messages[0]?.type, 'worker_done');
  assert.deepEqual(calls()[0]?.slice(2), [
    '--run',
    'run_1',
    '--wait',
    '--timeout-ms',
    '50',
    '--ack',
    'delivery_0',
    '--json',
  ]);
});

test('worker-show reads the reusable handle and the fleet liveness verdict', async () => {
  useTestSettings();
  // The shape Orca 1.4.237 returns for a structured (chat) worker.
  const shown = {
    dispatch: { assigneeHandle: 'structworker_c1d5', assigneePaneKey: 'structured-agent-session-7cf1:7a5e' },
    worker: { state: 'succeeded', stage: 'settled', agentTerminalHandle: 'structworker_c1d5' },
    terminal: null,
    projection: { liveness: { verdict: 'exited', reason: 'gone' } },
  };
  const { client } = fakeOrca(JSON.stringify({ ok: true, result: shown }));
  assert.deepEqual(await client.showWorker('dispatch_1'), { handle: 'structworker_c1d5', liveness: 'exited' });
});
