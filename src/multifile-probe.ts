import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { Workspaces } from './workspaces.js';
import { Executions } from './executions.js';
import { Checks, type SimplificationAssessment } from './checks.js';
import { Deliveries } from './deliveries.js';
import { Implementations } from './implementations.js';
import { runSession, Sessions } from './sessions.js';
import { renderReport } from './report.js';
import { brief, expectedStdout, fixtureFiles, oracle, obsoleteFile, obsoleteContent, deletionCriterion, deletionOracle, deletionStdout } from './multifile-fixture.js';
import { orcaExecutable } from './orca.js';
import { interruptAfterEdit } from './probe-interruption.js';

const { values } = parseArgs({ options: { live: { type: 'boolean' }, provider: { type: 'string' },
  orca: { type: 'boolean' }, 'interrupt-after-edit': { type: 'boolean' }, 'create-library': { type: 'boolean' }, 'delete-obsolete': { type: 'boolean' },
  finish: { type: 'string' }, db: { type: 'string' }, assessment: { type: 'string' } }, strict: true });
const continuing = values.finish !== undefined;
if (!values.live || (continuing
  ? !values.finish || !values.db || !values.assessment || values.provider !== undefined || values.orca !== undefined || values['interrupt-after-edit'] !== undefined || values['create-library'] !== undefined || values['delete-obsolete'] !== undefined
  : values.db !== undefined || values.assessment !== undefined || (values.provider !== undefined && !['codex', 'claude'].includes(values.provider)))) {
  throw new Error('Usage: probe:multifile -- --live [--provider codex|claude] [--orca] [--create-library] [--delete-obsolete] [--interrupt-after-edit], then --live --finish <execution-id> --db <journal> --assessment <JSON file> (uses subscriptions)');
}
if (values.orca && (process.env.ORCA_PAIRING_CODE || process.env.ORCA_ENVIRONMENT)) throw new Error('The Orca probe requires the local runtime without remote overrides');
if (process.platform !== 'win32') throw new Error('This probe requires Windows command supervision');
// A continuation must open an existing journal, never silently create one.
if (continuing && !existsSync(resolve(values.db!))) throw new Error('Continuation journal does not exist');
const root = continuing ? null : resolve('.grampus', 'task-probes', randomUUID());
if (root) mkdirSync(root, { recursive: true });
const db = root ? join(root, 'journal.sqlite') : resolve(values.db!);
const store = new Store(db);
const workflow = new Workflow(store); const checks = new Checks(store); const executions = new Executions(store);
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true,
    timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

async function start(): Promise<void> {
  const repo = join(root!, 'repo'); mkdirSync(repo);
  const name = git(process.cwd(), 'config', 'user.name'); const email = git(process.cwd(), 'config', 'user.email');
  assert.ok(name && email, 'Configure your Git identity before running this probe');
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', name); git(repo, 'config', 'user.email', email);
  git(repo, 'config', 'commit.gpgsign', 'false'); git(repo, 'config', 'core.autocrlf', 'false');
  for (const [file, content] of Object.entries(fixtureFiles)) {
    if (values['create-library'] && file === 'summary.cjs') continue;
    writeFileSync(join(repo, file), content);
  }
  if (values['delete-obsolete']) {
    writeFileSync(join(repo, obsoleteFile), obsoleteContent);
    writeFileSync(join(repo, 'AGENTS.md'), fixtureFiles['AGENTS.md']!.replace('Only the two named implementation files may change.',
      `Only summary.cjs and cli.cjs may be edited or created; ${obsoleteFile} may only be deleted.`));
  }
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Summary command baseline');
  const task = workflow.create(values['delete-obsolete'] ? { ...brief, outcome: `${brief.outcome} Remove ${obsoleteFile}.`,
    criteria: [...brief.criteria, deletionCriterion], plan: `${brief.plan} Remove ${obsoleteFile} through its explicit deletion-only policy.` } : brief);
  workflow.approve(task.id, 1);
  if (values.orca) {
    const response = JSON.parse(execFileSync(orcaExecutable(), ['repo', 'add', '--path', repo, '--json'],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000, stdio: 'pipe' })) as { ok?: boolean };
    assert.equal(response.ok, true, 'Orca fixture repository registration failed');
  }
  const workspaces = new Workspaces(store);
  const workspace = values.orca ? await workspaces.createOrca(task.id, 1, repo, 'main')
    : await workspaces.create(task.id, 1, repo, join(root!, 'workspace'));
  const implementation = await executions.create(workspace.id, 1, values.provider === 'claude' ? 'claude' : 'codex');
  store.append(task.id, 1, 'probe.multifile_started', { executionId: implementation.id, root, createLibrary: values['create-library'] ?? false, deleteObsolete: values['delete-obsolete'] ?? false });
  console.log(JSON.stringify({ stage: 'implementation', db, executionId: implementation.id }));
  const before = await checks.snapshot(implementation.id);
  const policy = { artifact: before.artifact, instructionsDigest: before.instructionsDigest,
    files: values['create-library'] ? ['cli.cjs'] : ['summary.cjs', 'cli.cjs'],
    ...(values['create-library'] ? { create: ['summary.cjs'] } : {}),
    ...(values['delete-obsolete'] ? { delete: [obsoleteFile] } : {}) };
  if (values['interrupt-after-edit']) {
    const recovery = await interruptAfterEdit(store, implementation, workspace, root!, policy);
    writeFileSync(join(root!, 'report.md'), renderReport(store, task.id));
    writeFileSync(join(root!, 'recovery.json'), JSON.stringify(recovery, null, 2));
    console.log(JSON.stringify(recovery, null, 2));
    return;
  }
  const edited = await new Implementations(store).run(implementation.id, policy);
  assert.equal(edited.phase, 'completed', edited.error ?? edited.result?.error ?? JSON.stringify(edited.process));
  assert.ok(store.sessionEvents(implementation.sessionId).some(event => event.type === 'tool.authorized'
    && ['Edit', 'Write', 'apply_patch'].includes((event.data as { data: { tool: string } }).data.tool)), 'Expected an authorized native write');
  for (const file of ['summary.cjs', 'cli.cjs']) assert.notEqual(readFileSync(join(workspace.path!, file), 'utf8'), fixtureFiles[file], `${file} must change`);
  if (values['delete-obsolete']) {
    assert.equal(existsSync(join(workspace.path!, obsoleteFile)), false, 'The obsolete file must actually be removed');
    assert.ok(store.sessionEvents(implementation.sessionId).some(event => {
      if (!['tool.deleted', 'tool.authorized'].includes(event.type)) return false;
      const data = (event.data as { data: { tool?: string; path?: string; paths?: string[] } }).data;
      return event.type === 'tool.deleted' && data.path === obsoleteFile
        || event.type === 'tool.authorized' && data.tool === 'apply_patch' && data.paths?.includes(obsoleteFile);
    }), 'Expected a journaled scoped deletion');
  }
  const snapshot = await checks.snapshot(implementation.id);
  const validation = await checks.run(implementation.id, { name: 'Summary library and command regression', file: process.execPath,
    args: ['-e', values['delete-obsolete'] ? deletionOracle : oracle], timeoutMs: 30_000, artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest });
  assert.equal(validation.phase, 'passed', validation.error ?? validation.result?.stderr ?? undefined);
  await checks.finish(implementation.id, validation.id);
  // This is deliberately skipped until a caller has inspected the actual output.
  writeFileSync(join(root!, 'assessment.json'), JSON.stringify({ artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest, outcome: 'skipped', summary: 'Awaiting inspection of the generated code and behavioral checks.' }, null, 2));
  store.append(task.id, 1, 'probe.multifile_checkpoint', { executionId: implementation.id, artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest, validationId: validation.id, expectedStdout: values['delete-obsolete'] ? deletionStdout : expectedStdout,
    root, createdFiles: policy.create ?? [], deletedFiles: policy.delete ?? [] });
  writeFileSync(join(root!, 'report.md'), renderReport(store, task.id));
  console.log(JSON.stringify({ stage: 'awaiting-simplification', db, executionId: implementation.id, workspace: workspace.path,
    assessment: join(root!, 'assessment.json'), validation: validation.phase, validationId: validation.id,
    next: 'Inspect both files and the saved validation command (check-show). Set an honest assessment outcome and summary, then use --finish with this execution, journal and assessment.' }, null, 2));
}

async function finish(): Promise<void> {
  const implementation = executions.get(values.finish!);
  const task = workflow.get(implementation.taskId);
  const checkpoint = store.events(task.id).find(event => event.type === 'probe.multifile_checkpoint'
    && (event.data as { executionId?: string }).executionId === implementation.id);
  assert.ok(checkpoint, 'This execution has no submitted multi-file pilot checkpoint');
  const saved = checkpoint.data as { artifact: string; instructionsDigest: string; validationId: string; expectedStdout: string; root: string; createdFiles?: string[]; deletedFiles?: string[] };
  assert.ok(!store.events(task.id).some(event => event.type === 'probe.multifile_continuation'),
    'Continuation was already requested. Inspect/recover through the ordinary CLI; no automatic replay.');
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
    assert.ok(!store.events(task.id).some(event => event.type === 'probe.multifile_continuation'),
      'Continuation was already requested. Inspect/recover its operations through the ordinary CLI; inference and Git writes are never replayed.');
    store.append(task.id, task.version, 'probe.multifile_continuation', { executionId: implementation.id });
  });
  const implementer = new Sessions(store).get(implementation.sessionId).provider;
  const review = await executions.create(implementation.workspaceId, implementation.version, implementer === 'codex' ? 'claude' : 'codex', 'review');
  console.log(JSON.stringify({ stage: 'independent-review', executionId: review.id }));
  const reviewed = await runSession(store, review.sessionId, 'Review the library and CLI against every approved criterion, including any file lifecycle requirements, input preservation, invalid values and exact command error behavior.',
    { artifactReview: true, timeoutMs: 120_000 });
  assert.equal(reviewed.status, 'completed', reviewed.error ?? undefined);
  assert.equal(reviewed.reply?.kind, 'review');
  assert.ok(!reviewed.reply!.findings.some(finding => finding.severity === 'blocking'), 'Blocking findings require resolution; no automatic retry');
  const verification = await checks.run(implementation.id, { ...validation.spec, name: 'Summary acceptance',
    criteria: task.brief.criteria, expectedStdout: saved.expectedStdout });
  assert.equal(verification.phase, 'passed', verification.error ?? verification.result?.stderr ?? undefined);
  const delivery = await new Deliveries(store).run(implementation.id, { artifact: saved.artifact,
    instructionsDigest: saved.instructionsDigest, message: 'Implement the summary library and JSON command', timeoutMs: 30_000 });
  assert.equal(delivery.phase, 'delivered', delivery.error ?? undefined);
  const workspace = new Workspaces(store).get(implementation.workspaceId);
  const summary = { passed: true, phase: workflow.get(task.id).phase, commit: delivery.commit,
    workspace: { adapter: workspace.adapter, identityKey: workspace.orca?.identityKey ?? null },
    implementation: { provider: implementer, model: new Sessions(store).get(implementation.sessionId).model },
    review: { provider: new Sessions(store).get(review.sessionId).provider, model: new Sessions(store).get(review.sessionId).model, findings: reviewed.reply!.findings },
    verification: verification.phase, createdFiles: saved.createdFiles ?? [], deletedFiles: saved.deletedFiles ?? [],
    scope: `${workspace.adapter === 'orca' ? 'Local Orca workspace' : 'Standalone Git'} on Windows, two implementation files, explicit simplification, live independent review and verified local delivery; no push` };
  writeFileSync(join(saved.root, 'report.md'), renderReport(store, task.id));
  writeFileSync(join(saved.root, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

(continuing ? finish() : start()).catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  console.error(`Evidence retained in ${db}`); process.exitCode = 1;
}).finally(() => store.close());
