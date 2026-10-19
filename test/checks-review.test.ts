// Check tests: independent review, verification, completion and quality assessment gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSession } from '../src/execution/sessions.js';
import type { Checks } from '../src/verification/checks.js';
import { runCheckProcess, retainedOutput } from '../src/process/check-process.js';
import type { Connector, Reply } from '../src/providers/types.js';
import { windows, fixture, deadController, crashDuringInspection } from './helpers/checks.js';

const reviewReply: Reply = {
  kind: 'review',
  text: 'The supplied greeting matches the brief.',
  questions: [],
  findings: [],
};

const reviewer =
  (reply: Reply = reviewReply): Connector =>
  async (_, options) => {
    options.emit({ type: 'session.connected', data: { providerSessionId: 'fixture-review', model: 'fixture-model' } });
    return {
      turn: async () => ({ status: 'completed', reply, usage: null, error: null }),
      interrupt: async () => {},
      close: async () => {},
    };
  };

async function submitted(f: Awaited<ReturnType<typeof fixture>>) {
  const snapshot = await f.checks.snapshot(f.execution.id);
  f.workflow.finish(f.task.id, f.execution.attemptId, 1, 'succeeded', snapshot.artifact, 'Trusted fixture submission');
  return snapshot;
}

test('artifact review supplies verified files and records independent evidence only after provider shutdown', async t => {
  const f = await fixture(t);
  const snapshot = await submitted(f);
  const review = await f.executions.create(f.workspace.id, 1, 'claude', { role: 'review' });
  const connector: Connector = async (_, options) => ({
    turn: async prompt => {
      assert.match(prompt, /console.log\('hello'\)/);
      assert.match(prompt, /Check the greeting output/);
      assert.match(prompt, /Print hello/);
      assert.ok(prompt.includes(snapshot.artifact));
      assert.ok(f.store.lease(f.workspace.id));
      options.emit({
        type: 'session.connected',
        data: { providerSessionId: 'fixture-review', model: 'fixture-model' },
      });
      return { status: 'completed', reply: reviewReply, usage: null, error: null };
    },
    interrupt: async () => {},
    close: async () => {
      assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
      assert.ok(f.store.lease(f.workspace.id));
    },
  });
  const result = await runSession(f.store, review.sessionId, 'Review', { artifactReview: true }, connector);
  assert.equal(result.status, 'completed');
  const evidence = f.workflow.get(f.task.id).evidence.at(-1)!;
  assert.equal(evidence.kind, 'review');
  assert.equal(evidence.outcome, 'passed');
  assert.equal(evidence.agent?.sessionId, review.sessionId);
  assert.equal(evidence.artifact, snapshot.artifact);
  assert.equal(f.store.lease(f.workspace.id), null);
  assert.ok(f.workflow.blockers(f.task.id).includes('verification has not passed'));
});

test('changed artifacts block review dispatch and changes during review cannot pass', async t => {
  const f = await fixture(t);
  await submitted(f);
  const review = await f.executions.create(f.workspace.id, 1, 'claude', { role: 'review' });
  writeFileSync(join(f.workspace.path, 'greeting.js'), "console.log('changed');\n");
  let called = false;
  const stale = await runSession(f.store, review.sessionId, 'Review', { artifactReview: true }, async () => {
    called = true;
    throw new Error('Unexpected provider');
  });
  assert.equal(called, false);
  assert.equal(stale.status, 'failed');
  assert.match(stale.error!, /changed since/);
  writeFileSync(join(f.workspace.path, 'greeting.js'), "console.log('hello');\n");
  const changed = await runSession(f.store, review.sessionId, 'Review', { artifactReview: true }, async () => ({
    turn: async () => {
      writeFileSync(join(f.workspace.path, 'greeting.js'), 'changed during review');
      return { status: 'completed', reply: reviewReply, usage: null, error: null };
    },
    interrupt: async () => {},
    close: async () => {},
  }));
  assert.equal(changed.status, 'failed');
  assert.match(changed.error!, /changed during review/);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'failed');
});

test('blocking findings, questions, and unknown review shutdown cannot leave an older approval current', async t => {
  const f = await fixture(t);
  await submitted(f);
  const review = await f.executions.create(f.workspace.id, 1, 'codex', {
    role: 'review',
    fallbackReason: 'Fixture alternate provider unavailable',
  });
  await runSession(f.store, review.sessionId, 'Review', { artifactReview: true }, reviewer());
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
  await runSession(
    f.store,
    review.sessionId,
    'Review again',
    { artifactReview: true },
    reviewer({
      ...reviewReply,
      findings: [{ severity: 'blocking', description: 'Missing case', evidence: 'greeting.js' }],
    }),
  );
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'failed');
  await runSession(
    f.store,
    review.sessionId,
    'Review again',
    { artifactReview: true },
    reviewer({
      kind: 'question',
      text: 'Clarify',
      questions: [{ id: 'format', prompt: 'Which format?', choices: [] }],
      findings: [],
    }),
  );
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  await runSession(f.store, review.sessionId, '', { artifactReview: true, answers: { format: 'text' } }, reviewer());
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
  const unknown: Connector = async () => ({
    turn: async () => ({ status: 'completed', reply: reviewReply, usage: null, error: null }),
    interrupt: async () => {},
    close: async () => {
      throw new Error('Unknown exit');
    },
  });
  await runSession(f.store, review.sessionId, 'Review again', { artifactReview: true }, unknown);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  assert.ok(f.store.lease(f.workspace.id));
});

test(
  'verification requires exact criteria and observed output; a newer failure supersedes a pass',
  windows,
  async t => {
    const f = await fixture(t);
    await submitted(f);
    const spec = { ...(await f.spec("console.log('hello')")), criteria: ['Print hello'], expectedStdout: 'hello\n' };
    await assert.rejects(f.checks.run(f.execution.id, { ...spec, criteria: ['Unknown criterion'] }), /exact mapping/);
    assert.deepEqual(f.store.checks(f.execution.id), []);
    const passed = await f.checks.run(f.execution.id, spec);
    assert.equal(passed.phase, 'passed');
    assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.kind, 'verification');
    assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
    const wrong = await f.checks.run(f.execution.id, { ...spec, args: ['-e', "console.log('wrong')"] });
    assert.equal(wrong.result?.exitCode, 0);
    assert.equal(wrong.phase, 'failed');
    assert.match(wrong.error!, /expectedStdout/);
    assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'failed');
    const unavailable = await f.checks.run(
      f.execution.id,
      { ...spec, args: ['-e', "setTimeout(()=>console.log('lost output'),100)"], expectedStdout: '' },
      undefined,
      async options => {
        const result = await runCheckProcess(options);
        rmSync(join(options.receipt!.directory, 'stdout'));
        return { ...result, ...retainedOutput(options.receipt!.directory) };
      },
    );
    assert.equal(unavailable.result?.exitCode, 0);
    assert.equal(unavailable.phase, 'failed');
    assert.equal(unavailable.result?.outputUnavailable, true);
    writeFileSync(join(f.workspace.path, 'greeting.js'), "console.log('changed');\n");
    const newer = {
      ...(await f.spec("console.log('hello')")),
      criteria: spec.criteria,
      expectedStdout: spec.expectedStdout,
    };
    const stale = await f.checks.run(f.execution.id, newer);
    assert.equal(stale.phase, 'failed');
    assert.equal(stale.dispatch, 'not_requested');
    assert.match(stale.error!, /changed since implementation/);
  },
);

test(
  'verification crash recovery records skipped evidence and cannot resurrect an earlier passing gate',
  windows,
  async t => {
    const f = await fixture(t);
    await submitted(f);
    const spec = { ...(await f.spec("console.log('hello')")), criteria: ['Print hello'], expectedStdout: 'hello\n' };
    await f.checks.run(f.execution.id, spec);
    const lost = await f.checks.run(f.execution.id, spec, undefined, async options => {
      await runCheckProcess(options);
      throw new Error('Lost reply');
    });
    assert.equal(lost.phase, 'recovery_required');
    assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
    deadController(f);
    f.checks.recover(lost.id);
    assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
    assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  },
);

test('completion checks every gate and revalidates artifact before the final transaction', windows, async t => {
  const f = await fixture(t);
  const validation = await f.checks.run(f.execution.id, await f.spec());
  await f.checks.finish(f.execution.id, validation.id);
  const review = await f.executions.create(f.workspace.id, 1, 'claude', { role: 'review' });
  await runSession(f.store, review.sessionId, 'Review', { artifactReview: true }, reviewer());
  const spec = { ...(await f.spec("console.log('hello')")), criteria: ['Print hello'], expectedStdout: 'hello\n' };
  await f.checks.run(f.execution.id, spec);
  await assert.rejects(f.checks.complete(f.execution.id), /simplification/);
  await f.checks.assess(f.execution.id, {
    pass: 'simplification',
    artifact: spec.artifact,
    instructionsDigest: spec.instructionsDigest,
    outcome: 'passed',
    summary: 'Explicit fixture assessment of the one-line implementation',
  });
  writeFileSync(join(f.workspace.path, 'extra.txt'), 'after evidence');
  await assert.rejects(f.checks.complete(f.execution.id), /changed since/);
  assert.equal(f.workflow.get(f.task.id).phase, 'awaiting_verification');
  rmSync(join(f.workspace.path, 'extra.txt'));
  await f.checks.complete(f.execution.id);
  assert.equal(f.workflow.get(f.task.id).phase, 'complete');
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('explicit quality assessment records all outcomes, rejects stale inputs and supersedes older passes', async t => {
  const f = await fixture(t);
  const snapshot = await f.checks.snapshot(f.execution.id);
  const assessment = {
    pass: 'simplification',
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    outcome: 'passed' as const,
    summary:
      'One direct output statement; no duplication or unnecessary abstractions; output assertion exercises the requirement.',
  };
  await assert.rejects(f.checks.assess(f.execution.id, assessment), /submitted/);
  await submitted(f);
  await assert.rejects(f.checks.assess(f.execution.id, { ...assessment, summary: ' ' }), /nonempty/);
  await f.checks.assess(f.execution.id, assessment);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
  await assert.rejects(
    f.checks.assess(f.execution.id, { ...assessment, instructionsDigest: '0'.repeat(64) }),
    /changed/,
  );
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  await f.checks.assess(f.execution.id, assessment);
  writeFileSync(join(f.workspace.path, 'greeting.js'), "console.log('changed');\n");
  await assert.rejects(f.checks.assess(f.execution.id, assessment), /changed/);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  writeFileSync(join(f.workspace.path, 'greeting.js'), "console.log('hello');\n");
  for (const outcome of ['failed', 'skipped'] as const) {
    await f.checks.assess(f.execution.id, { ...assessment, outcome });
    assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, outcome);
    assert.ok(f.workflow.blockers(f.task.id).some(item => item.includes('simplification')));
  }
  const review = await f.executions.create(f.workspace.id, 1, 'claude', { role: 'review' });
  await assert.rejects(f.checks.assess(review.id, assessment), /implementation execution/);
  assert.equal(f.store.lease(f.workspace.id), null);
});

test('quality assessment CLI persists assessment and crashed reassessment recovers without restoring a pass', async t => {
  const f = await fixture(t);
  const snapshot = await submitted(f);
  const assessment = {
    pass: 'simplification',
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    outcome: 'passed',
    summary: 'Direct greeting with useful output coverage.',
  };
  const specFile = join(f.root, 'simplification.json');
  writeFileSync(specFile, JSON.stringify(assessment));
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  execFileSync(process.execPath, [cli, 'execution-assess', f.execution.id, specFile, '--db', f.db], {
    windowsHide: true,
    stdio: 'pipe',
  });
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
  crashDuringInspection(f, `await checks.assess(${JSON.stringify(f.execution.id)}, ${JSON.stringify(assessment)});`);
  assert.equal(f.store.lease(f.workspace.id)?.kind, 'assessment');
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  f.executions.recoverReadOnly(f.execution.id);
  assert.equal(f.store.lease(f.workspace.id), null);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'skipped');
  await f.checks.assess(f.execution.id, assessment as Parameters<Checks['assess']>[1]);
  assert.equal(f.workflow.get(f.task.id).evidence.at(-1)?.outcome, 'passed');
});
