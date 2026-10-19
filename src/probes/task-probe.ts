// Opt-in integration exercise, never part of the offline test suite: one greeting task through every
// gate with live providers and a verified local commit. Native mode uses supervised file tools; the
// default applies one allowlisted response.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { Store } from '../persistence/store.js';
import type { Execution } from '../persistence/records.js';
import { Workflow } from '../domain/workflow.js';
import { Workspaces } from '../repository/workspaces.js';
import { Executions } from '../execution/executions.js';
import { Checks } from '../verification/checks.js';
import { Deliveries } from '../execution/deliveries.js';
import { Implementations } from '../execution/implementations.js';
import { runSession, Sessions } from '../execution/sessions.js';
import { renderReport } from '../reporting/report.js';
import { orcaExecutable } from '../repository/orca.js';

const flags = process.argv.slice(2);
const orca = flags.includes('--orca');
const args = flags.filter(flag => flag !== '--orca').join(' ');
const native = ['--live --native', '--live --native-codex'].includes(args);
if ((!native && args !== '--live') || flags.filter(flag => flag === '--orca').length > 1)
  throw new Error(
    'Usage: npm run probe:task -- --live [--native|--native-codex] [--orca] (uses Codex and Claude subscriptions)',
  );
if (orca && (process.env.ORCA_PAIRING_CODE || process.env.ORCA_ENVIRONMENT))
  throw new Error('The Orca probe requires the local runtime without remote overrides');
const implementer = args === '--live --native' ? 'claude' : 'codex';
const reviewer = implementer === 'claude' ? 'codex' : 'claude';
if (process.platform !== 'win32') throw new Error('This probe requires Windows command supervision');
const relativeRoot = join('.grampus', 'task-probes', randomUUID());
const root = resolve(relativeRoot);
const repo = join(root, 'repo');
mkdirSync(repo, { recursive: true });
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}
const store = new Store(join(root, 'grampus.sqlite'));

/** A journaled tool decision (`{ runId, data }`); only the tool name is inspected. */
const toolEventSchema = z.object({ data: z.object({ tool: z.string() }) });

/** The fixture repository: one greeting script and repository instructions, committed with your Git identity. */
function fixtureRepository(): void {
  const name = git(process.cwd(), 'config', 'user.name');
  const email = git(process.cwd(), 'config', 'user.email');
  assert.ok(name && email, 'Configure your Git identity before running this probe');
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', name);
  git(repo, 'config', 'user.email', email);
  git(repo, 'config', 'commit.gpgsign', 'false');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n");
  writeFileSync(
    join(repo, 'AGENTS.md'),
    'Keep the greeting a single direct output statement. Verify its exact output.\n',
  );
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'Greeting baseline');
}

/**
 * Natively, the implementer edits greeting.js through supervised file tools. Otherwise Codex only
 * replies with one statement, which the probe applies after checking it is the single allowlisted
 * output statement. Returns the resulting source line.
 */
async function implementGreeting(
  checks: Checks,
  implementation: Execution,
  directory: string,
  taskId: string,
): Promise<string> {
  if (native) {
    const before = await checks.snapshot(implementation.id);
    const edited = await new Implementations(store).run(implementation.id, {
      artifact: before.artifact,
      instructionsDigest: before.instructionsDigest,
      files: ['greeting.js'],
    });
    assert.equal(edited.phase, 'completed', edited.error ?? edited.result?.error ?? JSON.stringify(edited.process));
    assert.ok(
      store
        .sessionEvents(implementation.sessionId)
        .some(
          event =>
            event.type === 'tool.authorized' &&
            ['Edit', 'Write', 'apply_patch'].includes(toolEventSchema.safeParse(event.data).data?.data.tool ?? ''),
        ),
      'Native editing must use an authorized write tool',
    );
    return readFileSync(join(directory, 'greeting.js'), 'utf8').trim();
  }
  const result = await runSession(
    store,
    implementation.sessionId,
    "The repository has greeting.js containing console.log('hello'); and AGENTS.md requiring one direct output statement and exact output verification. Supply the complete replacement JavaScript for greeting.js so it prints exactly hello world followed by one newline. Return kind message, and put only the one console.log statement in text (no Markdown). Do not use any tools.",
    { timeoutMs: 120_000 },
  );
  assert.equal(result.status, 'completed', result.error ?? 'Implementation conversation did not complete');
  assert.equal(result.reply?.kind, 'message');
  const source = result.reply.text.trim();
  assert.match(
    source,
    /^console\.log\((['"])hello world\1\);?$/,
    'Only the single allowlisted output statement may be applied',
  );
  writeFileSync(join(directory, 'greeting.js'), `${source}\n`);
  store.append(taskId, 1, 'probe.response_applied', {
    sessionId: implementation.sessionId,
    file: 'greeting.js',
    source,
    policy: 'Single allowlisted output statement; native provider tools disabled',
  });
  return source;
}

/** The whole pilot in one process; any failed gate throws and leaves the evidence in place. */
async function main(): Promise<void> {
  fixtureRepository();
  const workflow = new Workflow(store);
  const checks = new Checks(store);
  const executions = new Executions(store);
  const task = workflow.create({
    title: 'Greeting live integration pilot',
    outcome: 'Change the greeting from hello to hello world.',
    criteria: ['Running greeting.js prints exactly hello world followed by one newline.'],
    plan: `${native ? `${implementer} edits greeting.js through its bounded native file tools; ${reviewer} independently reviews.` : 'Codex supplies one statement; controller applies it and Claude independently reviews.'} Assess simplification, run regression and exact-output acceptance, then deliver a verified local commit and complete.`,
  });
  workflow.approve(task.id, 1);
  if (orca) {
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
  const workspace = orca
    ? await workspaces.createOrca(task.id, 1, repo, 'main')
    : await workspaces.create(task.id, 1, repo, join(root, 'workspace'));
  const implementation = await executions.create(workspace.id, 1, implementer);
  console.log(JSON.stringify({ stage: 'implementation', evidence: relativeRoot }));
  const source = await implementGreeting(checks, implementation, workspace.path, task.id);
  assert.match(source, /^console\.log\((['"])hello world\1\);?$/, 'Pilot expects a direct output statement');
  const snapshot = await checks.snapshot(implementation.id);
  const spec = {
    name: 'Greeting regression',
    file: process.execPath,
    args: [
      '-e',
      "const {execFileSync}=require('node:child_process');require('node:assert/strict').equal(execFileSync(process.execPath,['greeting.js'],{encoding:'utf8'}),'hello world\\n');",
    ],
    timeoutMs: 5000,
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
  };
  const validation = await checks.run(implementation.id, spec);
  assert.equal(validation.phase, 'passed', validation.error ?? undefined);
  await checks.finish(implementation.id, validation.id);
  await checks.assess(implementation.id, {
    pass: 'simplification',
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    outcome: 'passed',
    summary:
      'Controller inspected the single output statement: no names, duplication, abstraction or unrelated changes to simplify. Regression compares the executed program output to the requested greeting.',
  });
  console.log(JSON.stringify({ stage: 'independent-review', validation: validation.phase }));
  const review = await executions.create(workspace.id, 1, reviewer, { role: 'review' });
  const reviewed = await runSession(
    store,
    review.sessionId,
    'Review this tiny greeting change against its approved requirements.',
    { artifactReview: true, timeoutMs: 120_000 },
  );
  assert.equal(reviewed.status, 'completed', reviewed.error ?? undefined);
  assert.equal(reviewed.reply?.kind, 'review');
  assert.ok(
    !reviewed.reply.findings.some(finding => finding.severity === 'blocking'),
    'Blocking review findings require resolution; no automatic retry',
  );
  const verified = await checks.run(implementation.id, {
    ...spec,
    name: 'Greeting acceptance',
    args: ['greeting.js'],
    criteria: task.brief.criteria,
    expectedStdout: 'hello world\n',
  });
  assert.equal(verified.phase, 'passed', verified.error ?? undefined);
  const delivery = await new Deliveries(store).run(implementation.id, {
    artifact: snapshot.artifact,
    instructionsDigest: snapshot.instructionsDigest,
    message: 'Print the requested greeting',
    timeoutMs: 30_000,
  });
  assert.equal(delivery.phase, 'delivered', delivery.error ?? undefined);
  const commit = delivery.commit;
  assert.ok(commit, 'Delivery recorded no commit');
  assert.equal(git(workspace.path, 'status', '--porcelain'), '');
  assert.equal(git(workspace.path, 'show', `${commit}:greeting.js`), source);
  writeFileSync(join(root, 'report.md'), renderReport(store, task.id));
  const summary = {
    passed: true,
    phase: workflow.get(task.id).phase,
    commit,
    workspace: { adapter: workspace.adapter, identityKey: workspace.orca?.identityKey ?? null },
    implementation: { provider: implementer, model: new Sessions(store).get(implementation.sessionId).model },
    review: {
      provider: reviewer,
      model: new Sessions(store).get(review.sessionId).model,
      findings: reviewed.reply.findings,
    },
    validation: validation.phase,
    verification: verified.phase,
    evidence: relativeRoot,
    scope: `${orca ? 'Local Orca worktree with Grampus-owned processes' : 'Standalone Git'}, ${native ? `supervised ${implementer} native file editing` : 'controller-applied response'}, live independent review, supervised verified local delivery; no push`,
  };
  writeFileSync(join(root, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}
main()
  .catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    console.error(`Evidence retained under ${relativeRoot}`);
    process.exitCode = 1;
  })
  .finally(() => store.close());
