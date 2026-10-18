import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { Sessions } from './sessions.js';
import { Workflow } from './workflow.js';
import { Workspaces, type Workspace } from './workspaces.js';
import type { Execution, ExecutionLease } from './execution-state.js';
import type { EditPolicy } from './edit-policy.js';
import type { ImplementationRun } from './implementations.js';
import { readReceipt } from './check-recovery.js';
import { fixtureFiles } from './multifile-fixture.js';

const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
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

/** Opt-in fault injection: kill only the controller we launched, after a permitted file change. */
export async function interruptAfterEdit(
  store: Store,
  execution: Execution,
  workspace: Workspace,
  root: string,
  policy: EditPolicy,
  controllerProgram = cli,
) {
  const policyFile = join(root, 'edit-policy.json'),
    promptFile = join(root, 'interruption-prompt.txt');
  const deletion = policy.delete?.[0] ?? null;
  const contents = () =>
    Object.fromEntries(
      [...new Set([...Object.keys(fixtureFiles), ...(policy.delete ?? [])])].map(file => [
        file,
        existsSync(join(workspace.path!, file))
          ? createHash('sha256')
              .update(readFileSync(join(workspace.path!, file)))
              .digest('hex')
          : null,
      ]),
    );
  const initial = contents();
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
    const deadline = Date.now() + 150_000;
    const changed = () =>
      deletion
        ? !existsSync(join(workspace.path!, deletion))
        : existsSync(join(workspace.path!, 'summary.cjs')) &&
          readFileSync(join(workspace.path!, 'summary.cjs'), 'utf8') !== fixtureFiles['summary.cjs'];
    while (!changed()) {
      assert.ok(!controller.closed(), 'Controller exited before a real file change; interruption was not demonstrated');
      assert.ok(Date.now() < deadline, 'No file change observed before the interruption deadline');
      await delay(25);
    }
    const lease = store.lease<ExecutionLease>(workspace.id);
    assert.equal(lease?.controllerPid, controller.child.pid, 'Only the owned active controller may be killed');
    assert.equal(lease?.kind, 'implementation');
    assert.equal(lease?.executionId, execution.id);
    assert.ok(!controller.closed(), 'Controller settled before fault injection');
    killed = controller.child.kill();
    assert.ok(killed, 'Controller termination request failed');
    await controller.exited;
    const run = store.implementation<ImplementationRun>(lease.runId);
    assert.equal(run.phase, 'running', 'The controller must have crashed before settlement');
    assert.ok(run.receipt && run.supervisorPid, 'Dispatched implementation needs durable supervisor identity');
    const receiptDeadline = Date.now() + 30_000;
    while (true) {
      if (existsSync(join(run.receipt.directory, 'completion.json'))) {
        try {
          readReceipt(run.receipt, run.supervisorPid, run.toolPid);
          break;
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
    const receipt = readReceipt(run.receipt, run.supervisorPid, run.toolPid);
    assert.equal(receipt.exitConfirmed, true);
    assert.equal(receipt.reason, 'interrupted', 'Expected controller-loss shutdown, not a completed provider turn');
    const retained = contents();
    if (deletion) {
      assert.equal(retained[deletion], null, 'Expected the authorized file to remain deleted');
      assert.equal(
        retained['summary.cjs'],
        initial['summary.cjs'],
        'Implementation must still be incomplete at interruption',
      );
    } else assert.notEqual(retained['summary.cjs'], initial['summary.cjs']);
    assert.equal(retained['cli.cjs'], initial['cli.cjs'], 'Expected an incomplete task at interruption');
    assert.ok(store.lease(workspace.id), 'Crash must retain ownership until explicit recovery');
    const runsBefore = store.implementations<ImplementationRun>(execution.id).map(item => item.id);
    const activity = () =>
      store
        .sessionEvents(execution.sessionId)
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
    const eventsBefore = activity();
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
    assert.equal(store.implementation<ImplementationRun>(run.id).phase, 'interrupted');
    assert.equal(new Workflow(store).get(execution.taskId).phase, 'stopped');
    assert.equal(store.lease(workspace.id), null);
    assert.deepEqual(contents(), retained, 'Recovery must preserve all partial file contents');
    assert.deepEqual(
      store.implementations<ImplementationRun>(execution.id).map(item => item.id),
      runsBefore,
    );
    assert.deepEqual(activity(), eventsBefore, 'Recovery cannot start a provider turn, process or tool');
    assert.equal(
      new Workflow(store).get(execution.taskId).evidence.length,
      0,
      'Recovery cannot create completion evidence',
    );
    const inspected = await new Workspaces(store).inspect(workspace.id);
    assert.equal(inspected.head, execution.headAtCreation, 'Recovery cannot make a commit');
    const result = {
      passed: true,
      stage: 'recovered-interruption',
      taskPhase: 'stopped',
      implementationId: run.id,
      workspace: { adapter: workspace.adapter, identityKey: workspace.orca?.identityKey ?? null },
      provider: new Sessions(store).get(execution.sessionId).provider,
      model: new Sessions(store).get(execution.sessionId).model,
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
