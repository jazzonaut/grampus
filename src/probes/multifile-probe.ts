import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from '../persistence/store.js';
import { Workflow, activeCriteria, activeSlice } from '../domain/workflow.js';
import { Workspaces } from '../repository/workspaces.js';
import { Executions } from '../execution/executions.js';
import { Checks, type SimplificationAssessment } from '../verification/checks.js';
import { Deliveries } from '../execution/deliveries.js';
import { Implementations } from '../execution/implementations.js';
import { runSession, Sessions } from '../execution/sessions.js';
import { renderReport } from '../reporting/report.js';
import {
  brief,
  slicedBrief,
  libraryOracle,
  libraryStdout,
  expectedStdout,
  fixtureFiles,
  oracle,
  obsoleteFile,
  obsoleteContent,
  deletionCriterion,
  deletionOracle,
  deletionStdout,
} from './multifile-fixture.js';
import { orcaExecutable } from '../repository/orca.js';
import { interruptAfterEdit } from './probe-interruption.js';

const { values } = parseArgs({
  options: {
    live: { type: 'boolean' },
    provider: { type: 'string' },
    orca: { type: 'boolean' },
    'interrupt-after-edit': { type: 'boolean' },
    'create-library': { type: 'boolean' },
    'delete-obsolete': { type: 'boolean' },
    slices: { type: 'boolean' },
    next: { type: 'string' },
    finish: { type: 'string' },
    db: { type: 'string' },
    assessment: { type: 'string' },
  },
  strict: true,
});
const continuing = values.finish !== undefined;
const advancing = values.next !== undefined;
const resuming = continuing || advancing;
const startupFlags =
  values.provider !== undefined ||
  values.orca !== undefined ||
  values.slices !== undefined ||
  values['interrupt-after-edit'] !== undefined ||
  values['create-library'] !== undefined ||
  values['delete-obsolete'] !== undefined;
if (
  !values.live ||
  (continuing
    ? !values.finish || advancing || !values.db || !values.assessment || startupFlags
    : advancing
      ? !values.next || !values.db || values.assessment !== undefined || startupFlags
      : values.db !== undefined ||
        values.assessment !== undefined ||
        (values.provider !== undefined && !['codex', 'claude'].includes(values.provider)) ||
        (values.slices &&
          (values['interrupt-after-edit'] !== undefined ||
            values['create-library'] !== undefined ||
            values['delete-obsolete'] !== undefined)))
) {
  throw new Error(
    'Usage: probe:multifile -- --live [--provider codex|claude] [--orca] [--slices | --create-library --delete-obsolete --interrupt-after-edit], then --live --finish <execution-id> --db <journal> --assessment <JSON file>; sliced tasks continue with --live --next <task-id> --db <journal> (uses subscriptions)',
  );
}
if (values.orca && (process.env.ORCA_PAIRING_CODE || process.env.ORCA_ENVIRONMENT))
  throw new Error('The Orca probe requires the local runtime without remote overrides');
if (process.platform !== 'win32') throw new Error('This probe requires Windows command supervision');
// A continuation must open an existing journal, never silently create one.
if (resuming && !existsSync(resolve(values.db!))) throw new Error('Continuation journal does not exist');
const root = resuming ? null : resolve('.grampus', 'task-probes', randomUUID());
if (root) mkdirSync(root, { recursive: true });
const db = root ? join(root, 'journal.sqlite') : resolve(values.db!);
const store = new Store(db);
const workflow = new Workflow(store);
const checks = new Checks(store);
const executions = new Executions(store);
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

async function start(): Promise<void> {
  const repo = join(root!, 'repo');
  mkdirSync(repo);
  const name = git(process.cwd(), 'config', 'user.name');
  const email = git(process.cwd(), 'config', 'user.email');
  assert.ok(name && email, 'Configure your Git identity before running this probe');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', name);
  git(repo, 'config', 'user.email', email);
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  for (const [file, content] of Object.entries(fixtureFiles)) {
    if (values['create-library'] && file === 'summary.cjs') continue;
    writeFileSync(join(repo, file), content);
  }
  if (values['delete-obsolete']) {
    writeFileSync(join(repo, obsoleteFile), obsoleteContent);
    writeFileSync(
      join(repo, 'AGENTS.md'),
      fixtureFiles['AGENTS.md']!.replace(
        'Only the two named implementation files may change.',
        `Only summary.cjs and cli.cjs may be edited or created; ${obsoleteFile} may only be deleted.`,
      ),
    );
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Summary command baseline');
  const task = workflow.create(
    values.slices
      ? slicedBrief
      : values['delete-obsolete']
        ? {
            ...brief,
            outcome: `${brief.outcome} Remove ${obsoleteFile}.`,
            criteria: [...brief.criteria, deletionCriterion],
            plan: `${brief.plan} Remove ${obsoleteFile} through its explicit deletion-only policy.`,
          }
        : brief,
  );
  workflow.approve(task.id, 1);
  if (values.orca) {
    const response = JSON.parse(
      execFileSync(orcaExecutable(), ['repo', 'add', '--path', repo, '--json'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 120_000,
        stdio: 'pipe',
      }),
    ) as { ok?: boolean };
    assert.equal(response.ok, true, 'Orca fixture repository registration failed');
  }
  const workspaces = new Workspaces(store);
  const workspace = values.orca
    ? await workspaces.createOrca(task.id, 1, repo, 'main')
    : await workspaces.create(task.id, 1, repo, join(root!, 'workspace'));
  const implementation = await executions.create(workspace.id, 1, values.provider === 'claude' ? 'claude' : 'codex');
  store.append(task.id, 1, 'probe.multifile_started', {
    executionId: implementation.id,
    root,
    slices: values.slices ?? false,
    createLibrary: values['create-library'] ?? false,
    deleteObsolete: values['delete-obsolete'] ?? false,
  });
  await implement(implementation.id, root!, {
    createLibrary: values['create-library'] ?? false,
    deleteObsolete: values['delete-obsolete'] ?? false,
    interrupt: values['interrupt-after-edit'] ?? false,
  });
}

async function implement(
  executionId: string,
  probeRoot: string,
  options: { createLibrary?: boolean; deleteObsolete?: boolean; interrupt?: boolean } = {},
): Promise<void> {
  const implementation = executions.get(executionId);
  const task = workflow.get(implementation.taskId);
  const workspace = new Workspaces(store).get(implementation.workspaceId);
  const slice = activeSlice(task);
  const files = slice
    ? [slice.number === 1 ? 'summary.cjs' : 'cli.cjs']
    : options.createLibrary
      ? ['cli.cjs']
      : ['summary.cjs', 'cli.cjs'];
  const checkOracle = slice?.number === 1 ? libraryOracle : options.deleteObsolete ? deletionOracle : oracle;
  const checkStdout = slice?.number === 1 ? libraryStdout : options.deleteObsolete ? deletionStdout : expectedStdout;
  console.log(JSON.stringify({ stage: 'implementation', db, executionId: implementation.id }));
  const before = await checks.snapshot(implementation.id);
  const policy = {
    artifact: before.artifact,
    instructionsDigest: before.instructionsDigest,
    files,
    ...(options.createLibrary ? { create: ['summary.cjs'] } : {}),
    ...(options.deleteObsolete ? { delete: [obsoleteFile] } : {}),
  };
  if (options.interrupt) {
    const recovery = await interruptAfterEdit(store, implementation, workspace, probeRoot, policy);
    writeFileSync(join(probeRoot, 'report.md'), renderReport(store, task.id));
    writeFileSync(join(probeRoot, 'recovery.json'), JSON.stringify(recovery, null, 2));
    console.log(JSON.stringify(recovery, null, 2));
    return;
  }
  const edited = await new Implementations(store).run(implementation.id, policy);
  assert.equal(edited.phase, 'completed', edited.error ?? edited.result?.error ?? JSON.stringify(edited.process));
  assert.ok(
    store
      .sessionEvents(implementation.sessionId)
      .some(
        event =>
          event.type === 'tool.authorized' &&
          ['Edit', 'Write', 'apply_patch'].includes((event.data as { data: { tool: string } }).data.tool),
      ),
    'Expected an authorized native write',
  );
  for (const file of [...files, ...(policy.create ?? [])])
    assert.notEqual(readFileSync(join(workspace.path!, file), 'utf8'), fixtureFiles[file], `${file} must change`);
  if (slice?.number === 1)
    assert.equal(
      readFileSync(join(workspace.path!, 'cli.cjs'), 'utf8'),
      fixtureFiles['cli.cjs'],
      'CLI must remain unfinished in the library slice',
    );
  if (slice?.number === 2) {
    assert.ok(edited.before && edited.after, 'Completed editing must retain both snapshots');
    assert.equal(
      edited.before.files.find(file => file.path === 'summary.cjs')?.sha256,
      edited.after.files.find(file => file.path === 'summary.cjs')?.sha256,
      'CLI slice must preserve the delivered library',
    );
  }
  if (options.deleteObsolete) {
    assert.equal(existsSync(join(workspace.path!, obsoleteFile)), false, 'The obsolete file must actually be removed');
    assert.ok(
      store.sessionEvents(implementation.sessionId).some(event => {
        if (!['tool.deleted', 'tool.authorized'].includes(event.type)) return false;
        const data = (event.data as { data: { tool?: string; path?: string; paths?: string[] } }).data;
        return (
          (event.type === 'tool.deleted' && data.path === obsoleteFile) ||
          (event.type === 'tool.authorized' && data.tool === 'apply_patch' && data.paths?.includes(obsoleteFile))
        );
      }),
      'Expected a journaled scoped deletion',
    );
  }
  const snapshot = await checks.snapshot(implementation.id);
  const validation = await checks.run(implementation.id, {
    name: slice?.number === 1 ? 'Summary library regression' : 'Summary library and command regression',
    file: process.execPath,
    args: ['-e', checkOracle],
    timeoutMs: 30_000,
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
  });
  assert.equal(validation.phase, 'passed', validation.error ?? validation.result?.stderr ?? undefined);
  await checks.finish(implementation.id, validation.id);
  // This is deliberately skipped until a caller has inspected the actual output.
  const assessmentFile = join(probeRoot, slice ? `assessment-slice-${slice.number}.json` : 'assessment.json');
  writeFileSync(
    assessmentFile,
    JSON.stringify(
      {
        artifact: snapshot.artifact,
        instructionsDigest: snapshot.instructionsDigest,
        outcome: 'skipped',
        summary: 'Awaiting inspection of the generated code and behavioral checks.',
      },
      null,
      2,
    ),
  );
  store.append(task.id, 1, 'probe.multifile_checkpoint', {
    executionId: implementation.id,
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    validationId: validation.id,
    expectedStdout: checkStdout,
    root: probeRoot,
    sliceIndex: task.slice?.index ?? null,
    createdFiles: policy.create ?? [],
    deletedFiles: policy.delete ?? [],
  });
  writeFileSync(join(probeRoot, 'report.md'), renderReport(store, task.id));
  console.log(
    JSON.stringify(
      {
        stage: 'awaiting-simplification',
        db,
        executionId: implementation.id,
        workspace: workspace.path,
        taskId: task.id,
        slice,
        assessment: assessmentFile,
        validation: validation.phase,
        validationId: validation.id,
        next: 'Inspect both files and the saved validation command (check-show). Set an honest assessment outcome and summary, then use --finish with this execution, journal and assessment.',
      },
      null,
      2,
    ),
  );
}

async function next(): Promise<void> {
  const task = workflow.get(values.next!);
  const started = store.events(task.id).find(event => event.type === 'probe.multifile_started');
  const saved = started?.data as { slices?: boolean; root?: string; executionId?: string } | undefined;
  assert.ok(saved?.slices && saved.root && saved.executionId, 'This task has no sequential pilot origin');
  assert.equal(JSON.stringify(task.brief), JSON.stringify(slicedBrief), 'The sequential pilot brief changed');
  const requested = () => store.events(task.id).some(event => event.type === 'probe.multifile_next_requested');
  const noReplay =
    'Next slice was already requested. Inspect existing executions through the ordinary CLI; no automatic replay.';
  assert.ok(!requested(), noReplay);
  assert.equal(task.version, 1);
  assert.equal(task.phase, 'ready');
  assert.equal(task.slice?.index, 1);
  assert.equal(task.slice.completed.length, 1);
  store.transaction(() => {
    assert.ok(!requested(), noReplay);
    store.append(task.id, task.version, 'probe.multifile_next_requested', { sliceIndex: task.slice!.index });
  });
  const previous = new Sessions(store).get(executions.get(saved.executionId).sessionId);
  const implementation = await executions.create(
    executions.get(saved.executionId).workspaceId,
    task.version,
    previous.provider,
    'implementation',
    previous.model,
  );
  store.append(task.id, task.version, 'probe.multifile_next_started', {
    sliceIndex: task.slice.index,
    executionId: implementation.id,
  });
  await implement(implementation.id, saved.root);
}

async function finish(): Promise<void> {
  const implementation = executions.get(values.finish!);
  const task = workflow.get(implementation.taskId);
  const checkpoint = store
    .events(task.id)
    .find(
      event =>
        event.type === 'probe.multifile_checkpoint' &&
        (event.data as { executionId?: string }).executionId === implementation.id,
    );
  assert.ok(checkpoint, 'This execution has no submitted multi-file pilot checkpoint');
  const saved = checkpoint.data as {
    artifact: string;
    instructionsDigest: string;
    validationId: string;
    expectedStdout: string;
    root: string;
    createdFiles?: string[];
    deletedFiles?: string[];
  };
  const continued = () =>
    store
      .events(task.id)
      .some(
        event =>
          event.type === 'probe.multifile_continuation' &&
          (event.data as { executionId?: string }).executionId === implementation.id,
      );
  assert.ok(
    !continued(),
    'Continuation was already requested. Inspect/recover through the ordinary CLI; no automatic replay.',
  );
  const validation = checks.get(saved.validationId);
  assert.equal(validation.executionId, implementation.id);
  assert.equal(validation.phase, 'passed');
  const assessment = JSON.parse(readFileSync(resolve(values.assessment!), 'utf8')) as SimplificationAssessment;
  assert.equal(assessment.artifact, saved.artifact, 'Assessment must identify the checkpoint artifact');
  assert.equal(assessment.instructionsDigest, saved.instructionsDigest);
  // Failed/skipped judgments are journaled but never start review or delivery.
  await checks.simplify(implementation.id, assessment);
  assert.equal(assessment.outcome, 'passed', 'Simplification has not passed; inspect the result before continuing');
  store.transaction(() => {
    assert.ok(
      !continued(),
      'Continuation was already requested. Inspect/recover its operations through the ordinary CLI; inference and Git writes are never replayed.',
    );
    store.append(task.id, task.version, 'probe.multifile_continuation', { executionId: implementation.id });
  });
  const implementer = new Sessions(store).get(implementation.sessionId).provider;
  const review = await executions.create(
    implementation.workspaceId,
    implementation.version,
    implementer === 'codex' ? 'claude' : 'codex',
    'review',
  );
  console.log(JSON.stringify({ stage: 'independent-review', executionId: review.id }));
  const slice = activeSlice(task);
  const reviewed = await runSession(
    store,
    review.sessionId,
    slice
      ? `Review current slice ${slice.number}: ${slice.title} against its approved criteria. ${slice.final ? 'Inspect integration and all task criteria, including the previously delivered library.' : 'The CLI is intentionally unfinished and belongs to the next slice.'} Inspect correctness, input preservation, invalid values and maintainability.`
      : 'Review the library and CLI against every approved criterion, including any file lifecycle requirements, input preservation, invalid values and exact command error behavior.',
    { artifactReview: true, timeoutMs: 120_000 },
  );
  assert.equal(reviewed.status, 'completed', reviewed.error ?? undefined);
  assert.equal(reviewed.reply?.kind, 'review');
  assert.ok(
    !reviewed.reply.findings.some(finding => finding.severity === 'blocking'),
    'Blocking findings require resolution; no automatic retry',
  );
  const verification = await checks.run(implementation.id, {
    ...validation.spec,
    name: 'Summary acceptance',
    criteria: activeCriteria(task),
    expectedStdout: saved.expectedStdout,
  });
  assert.equal(verification.phase, 'passed', verification.error ?? verification.result?.stderr ?? undefined);
  const delivery = await new Deliveries(store).run(implementation.id, {
    artifact: saved.artifact,
    instructionsDigest: saved.instructionsDigest,
    message: slice ? `Implement ${slice.title.toLowerCase()}` : 'Implement the summary library and JSON command',
    timeoutMs: 30_000,
  });
  assert.equal(delivery.phase, 'delivered', delivery.error ?? undefined);
  const workspace = new Workspaces(store).get(implementation.workspaceId);
  const settled = workflow.get(task.id);
  assert.equal(
    settled.phase,
    slice && !slice.final ? 'ready' : 'complete',
    'Delivery must settle the expected slice state',
  );
  if (slice) assert.equal(settled.slice?.completed.length, slice.number, 'Exactly the current slice must be delivered');
  const summary = {
    passed: true,
    stage: settled.phase === 'ready' ? 'slice-delivered' : 'complete',
    phase: settled.phase,
    taskId: task.id,
    slice,
    commit: delivery.commit,
    slices: settled.slice?.completed,
    ...(settled.phase === 'ready' ? { next: `probe:multifile -- --live --next ${task.id} --db ${db}` } : {}),
    workspace: { adapter: workspace.adapter, identityKey: workspace.orca?.identityKey ?? null },
    implementation: { provider: implementer, model: new Sessions(store).get(implementation.sessionId).model },
    review: {
      provider: new Sessions(store).get(review.sessionId).provider,
      model: new Sessions(store).get(review.sessionId).model,
      findings: reviewed.reply.findings,
    },
    verification: verification.phase,
    createdFiles: saved.createdFiles ?? [],
    deletedFiles: saved.deletedFiles ?? [],
    scope: `${workspace.adapter === 'orca' ? 'Local Orca workspace' : 'Standalone Git'} on Windows, ${slice ? `slice ${slice.number}/${slice.total}` : 'two implementation files'}, explicit simplification, live independent review and verified local delivery; no push`,
  };
  writeFileSync(join(saved.root, 'report.md'), renderReport(store, task.id));
  writeFileSync(join(saved.root, 'result.json'), JSON.stringify(summary, null, 2));
  if (slice) writeFileSync(join(saved.root, `result-slice-${slice.number}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

(continuing ? finish() : advancing ? next() : start())
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Evidence retained in ${db}`);
    process.exitCode = 1;
  })
  .finally(() => store.close());
