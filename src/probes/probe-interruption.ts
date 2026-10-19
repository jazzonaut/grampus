// Opt-in fault injection for the multi-file probe: kills a live implementation controller after its
// first permitted file change and proves that explicit recovery settles the run from supervisor
// proof, keeps every partial file and never replays a provider turn.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import type { Store } from '../persistence/store.js';
import { Sessions } from '../execution/sessions.js';
import { Workflow } from '../domain/workflow.js';
import { Workspaces, type Workspace } from '../repository/workspaces.js';
import type { Execution, ImplementationRun } from '../persistence/records.js';
import type { EditPolicy } from '../execution/edit-policy.js';
import { readReceipt } from '../verification/check-recovery.js';
import { fixtureFiles } from './multifile-fixture.js';

const cli = fileURLToPath(new URL('../cli.js', import.meta.url));
/** Starts a controller process with bounded captured output; `closed` reports whether it has exited. */
function launch(args: string[], program = cli) {
  const child = execFile(process.execPath, [program, ...args], {
    windowsHide: true,
    timeout: 180_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  child.stdin?.end();
  let stdout = '',
    stderr = '';
  child.stdout?.on('data', chunk => {
    if (stdout.length < 4 * 1024 * 1024) stdout += chunk;
  });
  child.stderr?.on('data', chunk => {
    if (stderr.length < 4 * 1024 * 1024) stderr += chunk;
  });
  let closed = false;
  const exited = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      closed = true;
      resolve({ code, stdout, stderr });
    });
  });
  // A spawn error may arrive while the observer is waiting for file changes.
  void exited.catch(() => {});
  return { child, exited, closed: () => closed };
}

/** SHA-256 of each fixture file and planned deletion in the workspace; null for an absent file. */
function fileDigests(directory: string, policy: EditPolicy): Record<string, string | null> {
  return Object.fromEntries(
    [...new Set([...Object.keys(fixtureFiles), ...(policy.delete ?? [])])].map(file => [
      file,
      existsSync(join(directory, file))
        ? createHash('sha256')
            .update(readFileSync(join(directory, file)))
            .digest('hex')
        : null,
    ]),
  );
}

/** Waits until the agent's first permitted change (the deletion, or a new summary.cjs) is on disk. */
async function awaitFirstChange(
  controller: ReturnType<typeof launch>,
  directory: string,
  deletion: string | null,
): Promise<void> {
  const deadline = Date.now() + 150_000;
  const changed = () =>
    deletion
      ? !existsSync(join(directory, deletion))
      : existsSync(join(directory, 'summary.cjs')) &&
        readFileSync(join(directory, 'summary.cjs'), 'utf8') !== fixtureFiles['summary.cjs'];
  while (!changed()) {
    assert.ok(!controller.closed(), 'Controller exited before a real file change; interruption was not demonstrated');
    assert.ok(Date.now() < deadline, 'No file change observed before the interruption deadline');
    await delay(25);
  }
}

/**
 * Waits for the supervisor of a dispatched run to write terminal settlement proof after its controller
 * was killed. A supervisor that is still alive is waited for; any other receipt error is a failure.
 */
async function awaitSettlementProof(run: ImplementationRun): Promise<ReturnType<typeof readReceipt>> {
  assert.ok(run.receipt && run.supervisorPid, 'Dispatched implementation needs durable supervisor identity');
  const receiptDeadline = Date.now() + 30_000;
  for (;;) {
    if (existsSync(join(run.receipt.directory, 'completion.json'))) {
      try {
        return readReceipt(run.receipt, run.supervisorPid, run.toolPid);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'Supervisor is still alive or unverifiable') throw error;
      }
    }
    assert.ok(
      Date.now() < receiptDeadline,
      'Supervisor did not leave terminal settlement proof; retain the lease for investigation',
    );
    await delay(50);
  }
}

/** Session events that would show recovery starting a provider turn, process or tool. */
function providerActivity(store: Store, sessionId: string) {
  return store
    .sessionEvents(sessionId)
    .filter(event =>
      [
        'turn.requested',
        'turn.started',
        'process.started',
        'session.connected',
        'tool.authorized',
        'tool.denied',
        'tool.deleted',
      ].includes(event.type),
    );
}

/** The interruption left the task incomplete: the first change applied and everything after it untouched. */
function assertIncomplete(
  retained: Record<string, string | null>,
  initial: Record<string, string | null>,
  deletion: string | null,
): void {
  if (deletion) {
    assert.equal(retained[deletion], null, 'Expected the authorized file to remain deleted');
    assert.equal(
      retained['summary.cjs'],
      initial['summary.cjs'],
      'Implementation must still be incomplete at interruption',
    );
  } else assert.notEqual(retained['summary.cjs'], initial['summary.cjs']);
  assert.equal(retained['cli.cjs'], initial['cli.cjs'], 'Expected an incomplete task at interruption');
}

/**
 * Opt-in fault injection: kill only the controller we launched, after a permitted file change. Then a
 * new CLI process recovers the run, and the probe asserts that no provider turn, process or tool
 * started, no evidence or commit appeared and every partial file was kept. Any failed check throws an
 * `AssertionError`. `controllerProgram` lets tests launch a controller with a fake provider.
 */
export async function interruptAfterEdit(
  store: Store,
  execution: Execution,
  workspace: Workspace,
  root: string,
  policy: EditPolicy,
  controllerProgram = cli,
) {
  const directory = workspace.path;
  if (!directory) throw new Error('The interruption probe needs a created workspace');
  const policyFile = join(root, 'edit-policy.json'),
    promptFile = join(root, 'interruption-prompt.txt');
  const deletion = policy.delete?.[0] ?? null;
  const initial = fileDigests(directory, policy);
  writeFileSync(policyFile, JSON.stringify(policy));
  writeFileSync(
    promptFile,
    deletion
      ? `Implement the approved task. Delete ${JSON.stringify(deletion)} first in a separate file tool call. Inspect the remaining files before implementing summary.cjs and cli.cjs in later tool calls. Do not combine the deletion with other file changes.`
      : 'Implement the approved task. Implement summary.cjs first in a separate file tool call. After that, inspect your library implementation before editing cli.cjs in a later tool call. Do not combine the two file updates.',
  );
  const controller = launch(
    ['--db', store.path, 'execution-implement', execution.id, policyFile, '--prompt-file', promptFile],
    controllerProgram,
  );
  let killed = false;
  try {
    await awaitFirstChange(controller, directory, deletion);
    const lease = store.lease(workspace.id);
    assert.equal(lease?.controllerPid, controller.child.pid, 'Only the owned active controller may be killed');
    assert.equal(lease?.kind, 'implementation');
    assert.equal(lease?.executionId, execution.id);
    assert.ok(!controller.closed(), 'Controller settled before fault injection');
    killed = controller.child.kill();
    assert.ok(killed, 'Controller termination request failed');
    await controller.exited;
    const run = store.implementation(lease.runId);
    assert.equal(run.phase, 'running', 'The controller must have crashed before settlement');
    const receipt = await awaitSettlementProof(run);
    assert.equal(receipt.exitConfirmed, true);
    assert.equal(receipt.reason, 'interrupted', 'Expected controller-loss shutdown, not a completed provider turn');
    const retained = fileDigests(directory, policy);
    assertIncomplete(retained, initial, deletion);
    assert.ok(store.lease(workspace.id), 'Crash must retain ownership until explicit recovery');
    const runsBefore = store.implementations(execution.id).map(item => item.id);
    const eventsBefore = providerActivity(store, execution.sessionId);
    store.append(execution.taskId, execution.version, 'probe.controller_killed', {
      executionId: execution.id,
      implementationId: run.id,
      controllerPid: controller.child.pid,
      retained,
      receiptReason: receipt.reason,
    });
    // A new CLI process reconciles the existing run. It never sends a provider prompt.
    const recoveredProcess = launch(['--db', store.path, 'implementation-recover', run.id]);
    const recovered = await recoveredProcess.exited;
    assert.equal(recovered.code, 0, recovered.stderr || recovered.stdout);
    assert.equal(store.implementation(run.id).phase, 'interrupted');
    assert.equal(new Workflow(store).get(execution.taskId).phase, 'stopped');
    assert.equal(store.lease(workspace.id), null);
    assert.deepEqual(fileDigests(directory, policy), retained, 'Recovery must preserve all partial file contents');
    assert.deepEqual(
      store.implementations(execution.id).map(item => item.id),
      runsBefore,
    );
    assert.deepEqual(
      providerActivity(store, execution.sessionId),
      eventsBefore,
      'Recovery cannot start a provider turn, process or tool',
    );
    assert.equal(
      new Workflow(store).get(execution.taskId).evidence.length,
      0,
      'Recovery cannot create completion evidence',
    );
    const inspected = await new Workspaces(store).inspect(workspace.id);
    assert.equal(inspected.head, execution.headAtCreation, 'Recovery cannot make a commit');
    const session = new Sessions(store).get(execution.sessionId);
    const result = {
      passed: true,
      stage: 'recovered-interruption',
      taskPhase: 'stopped',
      implementationId: run.id,
      workspace: { adapter: workspace.adapter, identityKey: workspace.orca?.identityKey ?? null },
      provider: session.provider,
      model: session.model,
      receiptReason: receipt.reason,
      observedChange: { kind: deletion ? 'delete' : 'edit', path: deletion ?? 'summary.cjs' },
      partialFilesPreserved: true,
      inferenceReplayed: false,
      completionEvidence: false,
      next: 'Recovery stopped this attempt. Inspect partial files and explicitly create a fresh execution to continue.',
    };
    store.append(execution.taskId, execution.version, 'probe.interruption_verified', result);
    return result;
  } finally {
    if (!controller.closed() && !killed) {
      controller.child.kill();
      await controller.exited;
    }
  }
}
