import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Store } from './store.js';
import { Workflow } from './workflow.js';
import { Workspaces } from './workspaces.js';
import { Executions } from './executions.js';
import { Checks } from './checks.js';
import { runSession, Sessions } from './sessions.js';
import { renderReport } from './report.js';

// Opt-in integration exercise, never part of the offline test suite. The controller
// applies one allowlisted response; this does not enable native provider file tools.
if (process.argv.slice(2).join(' ') !== '--live') throw new Error('Usage: npm run probe:task -- --live (uses Codex and Claude subscriptions)');
if (process.platform !== 'win32') throw new Error('This probe requires Windows command supervision');
const relativeRoot = join('.grampus', 'task-probes', randomUUID());
const root = resolve(relativeRoot); const repo = join(root, 'repo');
mkdirSync(repo, { recursive: true });
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}
const store = new Store(join(root, 'journal.sqlite'));
async function main(): Promise<void> {
  const name = git(process.cwd(), 'config', 'user.name'); const email = git(process.cwd(), 'config', 'user.email');
  assert.ok(name && email, 'Configure your Git identity before running this probe');
  git(repo, 'init', '-b', 'main'); git(repo, 'config', 'user.name', name); git(repo, 'config', 'user.email', email);
  git(repo, 'config', 'commit.gpgsign', 'false'); git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'greeting.js'), "console.log('hello');\n");
  writeFileSync(join(repo, 'AGENTS.md'), 'Keep the greeting a single direct output statement. Verify its exact output.\n');
  git(repo, 'add', '.'); git(repo, 'commit', '-m', 'Greeting baseline');
  const workflow = new Workflow(store); const checks = new Checks(store); const executions = new Executions(store);
  const task = workflow.create({ title: 'Greeting live integration pilot', outcome: 'Change the greeting from hello to hello world.',
    criteria: ['Running greeting.js prints exactly hello world followed by one newline.'],
    plan: 'Codex supplies one statement; controller validates and applies it. Assess simplification, run a regression check, obtain independent Claude review, verify exact stdout, complete and commit locally.' });
  workflow.approve(task.id, 1);
  const workspace = await new Workspaces(store).create(task.id, 1, repo, join(root, 'workspace'));
  const implementation = await executions.create(workspace.id, 1, 'codex');
  console.log(JSON.stringify({ stage: 'implementation', evidence: relativeRoot }));
  const result = await runSession(store, implementation.sessionId,
    'The repository has greeting.js containing console.log(\'hello\'); and AGENTS.md requiring one direct output statement and exact output verification. Supply the complete replacement JavaScript for greeting.js so it prints exactly hello world followed by one newline. Return kind message, and put only the one console.log statement in text (no Markdown). Do not use any tools.', { timeoutMs: 120_000 });
  assert.equal(result.status, 'completed', result.error ?? 'Implementation conversation did not complete');
  assert.equal(result.reply?.kind, 'message');
  const source = result.reply!.text.trim();
  assert.match(source, /^console\.log\((['"])hello world\1\);?$/, 'Only the single allowlisted output statement may be applied');
  writeFileSync(join(workspace.path!, 'greeting.js'), `${source}\n`);
  store.append(task.id, 1, 'probe.response_applied', { sessionId: implementation.sessionId, file: 'greeting.js', source, policy: 'Single allowlisted output statement; native provider tools disabled' });
  const snapshot = await checks.snapshot(implementation.id);
  const spec = { name: 'Greeting regression', file: process.execPath,
    args: ['-e', "const {execFileSync}=require('node:child_process');require('node:assert/strict').equal(execFileSync(process.execPath,['greeting.js'],{encoding:'utf8'}),'hello world\\n');"],
    timeoutMs: 5000, artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest };
  const validation = await checks.run(implementation.id, spec); assert.equal(validation.phase, 'passed', validation.error ?? undefined);
  await checks.finish(implementation.id, validation.id);
  await checks.simplify(implementation.id, { artifact: snapshot.artifact, instructionsDigest: snapshot.instructionsDigest, outcome: 'passed',
    summary: 'Controller inspected the allowlisted single output statement: no names, duplication, abstraction or unrelated changes to simplify. Regression compares the executed program output to the requested greeting.' });
  console.log(JSON.stringify({ stage: 'independent-review', validation: validation.phase }));
  const review = await executions.create(workspace.id, 1, 'claude', 'review');
  const reviewed = await runSession(store, review.sessionId, 'Review this tiny greeting change against its approved requirements.', { artifactReview: true, timeoutMs: 120_000 });
  assert.equal(reviewed.status, 'completed', reviewed.error ?? undefined);
  assert.equal(reviewed.reply?.kind, 'review');
  assert.ok(!reviewed.reply!.findings.some(finding => finding.severity === 'blocking'), 'Blocking review findings require resolution; no automatic retry');
  const verified = await checks.run(implementation.id, { ...spec, name: 'Greeting acceptance', args: ['greeting.js'], criteria: task.brief.criteria, expectedStdout: 'hello world\n' });
  assert.equal(verified.phase, 'passed', verified.error ?? undefined);
  await checks.complete(implementation.id);
  // Probe delivery is explicit here, not a general Grampus commit/recovery service.
  assert.equal(readFileSync(join(workspace.path!, 'greeting.js'), 'utf8'), `${source}\n`);
  git(workspace.path!, 'add', 'greeting.js'); git(workspace.path!, 'commit', '-m', 'Print the requested greeting');
  const commit = git(workspace.path!, 'rev-parse', 'HEAD');
  assert.equal(git(workspace.path!, 'status', '--porcelain'), '');
  assert.equal(git(workspace.path!, 'show', `${commit}:greeting.js`), source);
  store.append(task.id, 1, 'probe.local_commit', { commit, checkedArtifact: snapshot.artifact, note: 'Post-completion local probe commit; staging and HEAD change the snapshot digest. No general delivery recovery or push.' });
  writeFileSync(join(root, 'report.md'), renderReport(store, task.id));
  const summary = { passed: true, phase: workflow.get(task.id).phase, commit,
    implementation: { provider: 'codex', model: new Sessions(store).get(implementation.sessionId).model },
    review: { provider: 'claude', model: new Sessions(store).get(review.sessionId).model, findings: reviewed.reply!.findings },
    validation: validation.phase, verification: verified.phase, evidence: relativeRoot,
    scope: 'Standalone Git, controller-applied allowlisted response, live independent review, local commit; no native provider editing or automatic delivery recovery' };
  writeFileSync(join(root, 'result.json'), JSON.stringify(summary, null, 2)); console.log(JSON.stringify(summary, null, 2));
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); console.error(`Evidence retained under ${relativeRoot}`); process.exitCode = 1; }).finally(() => store.close());
