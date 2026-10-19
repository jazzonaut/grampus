// Live multi-file probe through subscriptions: a supervised native editing turn over a fixture
// repository, independent behavioural checks, an explicit human assessment between controller
// processes, a fresh other-provider review and verified local delivery. `--slices` runs the same flow
// per slice; `--interrupt-after-edit` instead proves crash recovery (./probe-interruption.ts).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { z } from 'zod';
import { Store, type JournalEvent, type RecordEvent } from '../persistence/store.js';
import { Workflow, activeCriteria, activeSlice } from '../domain/workflow.js';
import { qualityAssessmentSchema } from '../domain/quality-passes.js';
import { Workspaces } from '../repository/workspaces.js';
import { Executions } from '../execution/executions.js';
import { Checks } from '../verification/checks.js';
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
import { deepEqual } from '../domain/deep-equal.js';

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

/** A string option the usage check above has already required for this mode. */
function option(name: 'db' | 'next' | 'finish' | 'assessment'): string {
  const value = values[name];
  if (!value) throw new Error(`--${name} is required`);
  return value;
}

// A continuation must open an existing journal, never silently create one.
if (resuming && !existsSync(resolve(option('db')))) throw new Error('Continuation journal does not exist');
const root = resuming ? null : resolve('.grampus', 'task-probes', randomUUID());
if (root) mkdirSync(root, { recursive: true });
const db = root ? join(root, 'grampus.sqlite') : resolve(option('db'));
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

// Journal payloads this probe writes for itself and reads back in a later process.
const startedSchema = z.object({
  executionId: z.string(),
  root: z.string(),
  slices: z.boolean(),
});
const checkpointSchema = z.object({
  executionId: z.string(),
  artifact: z.string(),
  instructionsDigest: z.string(),
  validationId: z.string(),
  expectedStdout: z.string(),
  root: z.string(),
  createdFiles: z.array(z.string()).optional(),
  deletedFiles: z.array(z.string()).optional(),
});
const executionEventSchema = z.object({ executionId: z.string().optional() });
/** A journaled tool decision (`{ runId, data }`); only the fields this probe inspects. */
const toolEventSchema = z.object({
  data: z.object({ tool: z.string().optional(), path: z.string().optional(), paths: z.array(z.string()).optional() }),
});
/** The person's assessment file; the pass defaults to the simplification lens. */
const assessmentFileSchema = qualityAssessmentSchema.omit({ pass: true }).extend({ pass: z.string().optional() });

/** The tool name, path and paths of a journaled tool decision, or an empty record for any other shape. */
function toolData(event: RecordEvent) {
  return toolEventSchema.safeParse(event.data).data?.data ?? {};
}

/** Whether a probe event belongs to `executionId`. */
function forExecution(event: JournalEvent, type: string, executionId: string): boolean {
  return event.type === type && executionEventSchema.safeParse(event.data).data?.executionId === executionId;
}

/** Creates the fixture repository with the probe's own Git identity and returns its path. */
function fixtureRepository(probeRoot: string): string {
  const repo = join(probeRoot, 'repo');
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
    const instructions = fixtureFiles['AGENTS.md'];
    assert.ok(instructions, 'The fixture names its repository instructions');
    writeFileSync(join(repo, obsoleteFile), obsoleteContent);
    writeFileSync(
      join(repo, 'AGENTS.md'),
      instructions.replace(
        'Only the two named implementation files may change.',
        `Only summary.cjs and cli.cjs may be edited or created; ${obsoleteFile} may only be deleted.`,
      ),
    );
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Summary command baseline');
  return repo;
}

/** First run: creates the fixture, approves the task, creates the workspace and runs the first turn. */
async function start(probeRoot: string): Promise<void> {
  const repo = fixtureRepository(probeRoot);
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
    const response = z.object({ ok: z.boolean().optional() }).parse(
      JSON.parse(
        execFileSync(orcaExecutable(), ['repo', 'add', '--path', repo, '--json'], {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 120_000,
          stdio: 'pipe',
        }),
      ),
    );
    assert.equal(response.ok, true, 'Orca fixture repository registration failed');
  }
  const workspaces = new Workspaces(store);
  const workspace = values.orca
    ? await workspaces.createOrca(task.id, 1, repo, 'main')
    : await workspaces.create(task.id, 1, repo, join(probeRoot, 'workspace'));
  const implementation = await executions.create(workspace.id, 1, values.provider === 'claude' ? 'claude' : 'codex');
  store.append(task.id, 1, 'probe.multifile_started', {
    executionId: implementation.id,
    root,
    slices: values.slices ?? false,
    createLibrary: values['create-library'] ?? false,
    deleteObsolete: values['delete-obsolete'] ?? false,
  });
  await implement(implementation.id, probeRoot, {
    createLibrary: values['create-library'] ?? false,
    deleteObsolete: values['delete-obsolete'] ?? false,
    interrupt: values['interrupt-after-edit'] ?? false,
  });
}

/**
 * The edits the agent was authorised to make are really on disk and journaled: every authorised file
 * changed, the unfinished slice's files did not, a later slice kept the delivered library and a
 * deletion went through the scoped delete tool.
 */
function assertEdits(input: {
  sessionId: string;
  directory: string;
  changed: string[];
  slice: ReturnType<typeof activeSlice>;
  edited: Awaited<ReturnType<Implementations['run']>>;
  deleteObsolete: boolean;
}): void {
  const { sessionId, directory, changed, slice, edited, deleteObsolete } = input;
  assert.ok(
    store
      .sessionEvents(sessionId)
      .some(
        event =>
          event.type === 'tool.authorized' && ['Edit', 'Write', 'apply_patch'].includes(toolData(event).tool ?? ''),
      ),
    'Expected an authorized native write',
  );
  for (const file of changed)
    assert.notEqual(readFileSync(join(directory, file), 'utf8'), fixtureFiles[file], `${file} must change`);
  if (slice?.number === 1)
    assert.equal(
      readFileSync(join(directory, 'cli.cjs'), 'utf8'),
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
  if (!deleteObsolete) return;
  assert.equal(existsSync(join(directory, obsoleteFile)), false, 'The obsolete file must actually be removed');
  assert.ok(
    store.sessionEvents(sessionId).some(event => {
      const data = toolData(event);
      return (
        (event.type === 'tool.deleted' && data.path === obsoleteFile) ||
        (event.type === 'tool.authorized' && data.tool === 'apply_patch' && !!data.paths?.includes(obsoleteFile))
      );
    }),
    'Expected a journaled scoped deletion',
  );
}

/** The files one implementation turn edits, and the oracle and output its checks expect. */
function turnFixture(
  slice: ReturnType<typeof activeSlice>,
  options: { createLibrary?: boolean; deleteObsolete?: boolean },
) {
  const library = slice?.number === 1;
  return {
    files: slice
      ? [library ? 'summary.cjs' : 'cli.cjs']
      : options.createLibrary
        ? ['cli.cjs']
        : ['summary.cjs', 'cli.cjs'],
    checkOracle: library ? libraryOracle : options.deleteObsolete ? deletionOracle : oracle,
    checkStdout: library ? libraryStdout : options.deleteObsolete ? deletionStdout : expectedStdout,
  };
}

/**
 * Writes the assessment file the person completes before `--finish`. It says `skipped` on purpose:
 * only a person who has inspected the actual output may change it to passed.
 */
function writeAssessmentTemplate(
  probeRoot: string,
  slice: ReturnType<typeof activeSlice>,
  snapshot: { artifact: string; instructionsDigest: string },
): string {
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
  return assessmentFile;
}

/**
 * One implementation turn and its regression check, then a journaled checkpoint and an assessment
 * template. The process stops there, so a person inspects the result before `--finish` continues.
 */
async function implement(
  executionId: string,
  probeRoot: string,
  options: { createLibrary?: boolean; deleteObsolete?: boolean; interrupt?: boolean } = {},
): Promise<void> {
  const implementation = executions.get(executionId);
  const task = workflow.get(implementation.taskId);
  const workspace = new Workspaces(store).get(implementation.workspaceId);
  const directory = workspace.path;
  if (!directory) throw new Error('The probe workspace has no directory');
  const slice = activeSlice(task);
  const { files, checkOracle, checkStdout } = turnFixture(slice, options);
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
  assertEdits({
    sessionId: implementation.sessionId,
    directory,
    changed: [...files, ...(policy.create ?? [])],
    slice,
    edited,
    deleteObsolete: options.deleteObsolete ?? false,
  });
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
  const assessmentFile = writeAssessmentTemplate(probeRoot, slice, snapshot);
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

/** `--next`: starts the following slice of a sequential pilot in a fresh execution, at most once. */
async function next(): Promise<void> {
  const task = workflow.get(option('next'));
  const started = store.events(task.id).find(event => event.type === 'probe.multifile_started');
  const saved = startedSchema.safeParse(started?.data).data;
  assert.ok(saved?.slices && saved.root && saved.executionId, 'This task has no sequential pilot origin');
  assert.ok(deepEqual(task.brief, slicedBrief), 'The sequential pilot brief changed');
  const requested = () => store.events(task.id).some(event => event.type === 'probe.multifile_next_requested');
  const noReplay =
    'Next slice was already requested. Inspect existing executions through the ordinary CLI; no automatic replay.';
  assert.ok(!requested(), noReplay);
  assert.equal(task.version, 1);
  assert.equal(task.phase, 'ready');
  const progress = task.slice;
  assert.ok(progress, 'The sequential pilot tracks slices');
  assert.equal(progress.index, 1);
  assert.equal(progress.completed.length, 1);
  // Checked again inside the transaction, so two continuations cannot both claim the next slice.
  store.transaction(() => {
    assert.ok(!requested(), noReplay);
    store.append(task.id, task.version, 'probe.multifile_next_requested', { sliceIndex: progress.index });
  });
  const previous = new Sessions(store).get(executions.get(saved.executionId).sessionId);
  const implementation = await executions.create(
    executions.get(saved.executionId).workspaceId,
    task.version,
    previous.provider,
    { model: previous.model },
  );
  store.append(task.id, task.version, 'probe.multifile_next_started', {
    sliceIndex: progress.index,
    executionId: implementation.id,
  });
  await implement(implementation.id, saved.root);
}

/** The summary written once delivery settled, for the person running the probe. */
function deliverySummary(input: {
  taskId: string;
  slice: ReturnType<typeof activeSlice>;
  saved: z.infer<typeof checkpointSchema>;
  implementationSession: string;
  reviewSession: string;
  findings: unknown;
  verification: string;
  commit: string | null;
  workspaceId: string;
}) {
  const { taskId, slice, saved } = input;
  const workspace = new Workspaces(store).get(input.workspaceId);
  const settled = workflow.get(taskId);
  const sessions = new Sessions(store);
  const implementer = sessions.get(input.implementationSession),
    reviewer = sessions.get(input.reviewSession);
  return {
    passed: true,
    stage: settled.phase === 'ready' ? 'slice-delivered' : 'complete',
    phase: settled.phase,
    taskId,
    slice,
    commit: input.commit,
    slices: settled.slice?.completed,
    ...(settled.phase === 'ready' ? { next: `probe:multifile -- --live --next ${taskId} --db ${db}` } : {}),
    workspace: { adapter: workspace.adapter, identityKey: workspace.orca?.identityKey ?? null },
    implementation: { provider: implementer.provider, model: implementer.model },
    review: { provider: reviewer.provider, model: reviewer.model, findings: input.findings },
    verification: input.verification,
    createdFiles: saved.createdFiles ?? [],
    deletedFiles: saved.deletedFiles ?? [],
    scope: `${workspace.adapter === 'orca' ? 'Local Orca workspace' : 'Standalone Git'} on Windows, ${slice ? `slice ${slice.number}/${slice.total}` : 'two implementation files'}, explicit simplification, live independent review and verified local delivery; no push`,
  };
}

/**
 * `--finish`: records the person's assessment, then (only once it passed) an other-provider review,
 * acceptance and verified delivery. Journaled once per execution, so a rerun never replays inference.
 */
async function finish(): Promise<void> {
  const implementation = executions.get(option('finish'));
  const task = workflow.get(implementation.taskId);
  const checkpoint = store
    .events(task.id)
    .find(event => forExecution(event, 'probe.multifile_checkpoint', implementation.id));
  assert.ok(checkpoint, 'This execution has no submitted multi-file pilot checkpoint');
  const saved = checkpointSchema.parse(checkpoint.data);
  const continued = () =>
    store.events(task.id).some(event => forExecution(event, 'probe.multifile_continuation', implementation.id));
  assert.ok(
    !continued(),
    'Continuation was already requested. Inspect/recover through the ordinary CLI; no automatic replay.',
  );
  const validation = checks.get(saved.validationId);
  assert.equal(validation.executionId, implementation.id);
  assert.equal(validation.phase, 'passed');
  const assessment = assessmentFileSchema.parse(JSON.parse(readFileSync(resolve(option('assessment')), 'utf8')));
  assert.equal(assessment.artifact, saved.artifact, 'Assessment must identify the checkpoint artifact');
  assert.equal(assessment.instructionsDigest, saved.instructionsDigest);
  // Failed/skipped judgments are journaled but never start review or delivery.
  await checks.assess(implementation.id, { ...assessment, pass: assessment.pass || 'simplification' });
  assert.equal(assessment.outcome, 'passed', 'Simplification has not passed; inspect the result before continuing');
  // Checked again inside the transaction, so two continuations cannot both proceed.
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
    { role: 'review' },
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
  const settled = workflow.get(task.id);
  assert.equal(
    settled.phase,
    slice && !slice.final ? 'ready' : 'complete',
    'Delivery must settle the expected slice state',
  );
  if (slice) assert.equal(settled.slice?.completed.length, slice.number, 'Exactly the current slice must be delivered');
  const summary = deliverySummary({
    taskId: task.id,
    slice,
    saved,
    implementationSession: implementation.sessionId,
    reviewSession: review.sessionId,
    findings: reviewed.reply.findings,
    verification: verification.phase,
    commit: delivery.commit,
    workspaceId: implementation.workspaceId,
  });
  writeFileSync(join(saved.root, 'report.md'), renderReport(store, task.id));
  writeFileSync(join(saved.root, 'result.json'), JSON.stringify(summary, null, 2));
  if (slice) writeFileSync(join(saved.root, `result-slice-${slice.number}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

/** Starting a probe needs the fresh probe directory; a continuation reuses the journal instead. */
function startFresh(): Promise<void> {
  if (!root) throw new Error('A new probe needs a fresh probe directory');
  return start(root);
}

(continuing ? finish() : advancing ? next() : startFresh())
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Evidence retained in ${db}`);
    process.exitCode = 1;
  })
  .finally(() => store.close());
