import { parseArgs } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, defaultDatabasePath } from './store.js';
import { Workflow, type Brief } from './workflow.js';
import { doctor } from './doctor.js';
import { runDemo } from './demo.js';
import { renderReport } from './report.js';
import { Sessions, runSession } from './sessions.js';
import type { Provider } from './agents/types.js';
import { Workspaces } from './workspaces.js';
import { Executions } from './executions.js';
import type { Execution } from './execution-state.js';
import { Checks, type CheckSpec } from './checks.js';
import { Deliveries } from './deliveries.js';
import { Implementations } from './implementations.js';

const help = `Grampus — local agent controller

  doctor [--orca]                 Check local interfaces; no inference calls
  demo                           Run a synthetic workflow in a fresh temporary database
  create <brief.json>             Store title, outcome, criteria[], plan and optional ordered slices[]
  approve <task-id> <version>     Approve that exact brief version
  list                           List stored tasks
  show <task-id>                  Show a task and completion blockers
  report <task-id>                Print a Markdown report from the journal
  workspace-new <task-id> <version>  Create a worktree (--repo, --path, optional --base)
                                  Orca mode: --orca --repo <path> --base <ref>; omit --path
  workspace-list                 List workspace reservations
  workspace-show <id>             Show saved workspace state and journal
  workspace-inspect <id>          Verify Git identity and show current HEAD/dirty state
  workspace-recover <id>          Reconcile interrupted creation without replaying Git
  execution-new <workspace-id> <version> <codex|claude>  Start a linked attempt (--role implementation|review)
  execution-list                 List linked task/session executions
  execution-show <id>            Show linked session, workspace lease and execution events
  execution-close <id>           Close an idle execution; never force-release a lease
  execution-snapshot <id>        Inspect repository content, diff and instruction digest
  execution-check <id> <file.json>  Run an explicit check against that snapshot (Windows)
  execution-finish <id> <check-id> Submit implementation with the latest passing check
  execution-simplify <id> <file.json> Record an explicit assessment of the submitted artifact
  execution-verify <id> <file.json> Verify current slice criteria (all task criteria for final slice)
  execution-review <id>           Review a verified artifact (review execution; optional --answers-file)
  execution-complete <id>         Recheck artifact and require every completion gate
  execution-deliver <id> <file.json> Deliver current slice, ready the next or complete (Windows)
  execution-implement <id> <file.json> Run supervised Claude/Codex editing with an explicit policy
  implementation-show <id>        Show native editing scope, snapshots and result
  implementation-recover <id>     Confirm native tool shutdown without replaying inference
  delivery-show <id>              Show retained delivery request and process result
  delivery-recover <id>           Reconcile interrupted delivery without replaying Git writes
  execution-recover <id>          Recover a read-only operation after its controller exits
  check-show <id>                Show retained command, snapshots and output
  check-recover <id>             Reconcile a lost check using durable supervisor evidence
  session-new <codex|claude>      Create a conversation (--cwd, optional --model)
  session-send <id> <prompt>      Run one live turn (or use --prompt-file <path>)
  session-answer <id> <file.json> Answer pending question ids with a JSON object
  session-show <id>              Show saved identity, state, and session events
  session-list                   List conversations
  session-recover <id>           Reconcile only when recorded processes have exited

Use --db <path> for persistent task commands, or GRAMPUS_HOME for the data directory.
Live sessions use existing subscriptions. Ctrl+C requests interruption and waits for process exit.
--timeout-ms defaults to 120000; --interrupt-after-ms exercises cancellation after turn start.
The demo remains synthetic. Provider tools and unattended scheduling remain disabled.`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { db: { type: 'string' }, orca: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
      cwd: { type: 'string' }, model: { type: 'string' }, 'prompt-file': { type: 'string' },
      'answers-file': { type: 'string' },
      repo: { type: 'string' }, path: { type: 'string' }, base: { type: 'string' },
      role: { type: 'string' }, 'fallback-reason': { type: 'string' },
      'timeout-ms': { type: 'string' }, 'interrupt-after-ms': { type: 'string' } },
  });
  const [action, id, version] = positionals;
  if (!action || values.help) { console.log(help); return; }
  if (action === 'doctor') {
    const capabilities = await doctor(values.orca);
    console.log(JSON.stringify({ node: process.version, platform: process.platform, capabilities }, null, 2));
    if (capabilities.some(item => item.status === 'unavailable')) process.exitCode = 1;
    return;
  }
  if (action === 'demo') {
    if (values.db) throw new Error('demo uses an isolated database; omit --db');
    const path = join(mkdtempSync(join(tmpdir(), 'grampus-demo-')), 'journal.sqlite');
    const taskId = runDemo(path);
    const store = new Store(path);
    try { console.log(renderReport(store, taskId)); }
    finally { store.close(); }
    console.log(`\nRetained demo database: ${path}`);
    return;
  }
  if (action.startsWith('workspace-')) {
    if (!['workspace-new', 'workspace-list', 'workspace-show', 'workspace-inspect', 'workspace-recover'].includes(action)) throw new Error('Unknown workspace command');
    if (action !== 'workspace-list' && !id) throw new Error(`${action} requires an argument`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      const workspaces = new Workspaces(store);
      if (action === 'workspace-new') {
        if (values.orca && values.path) throw new Error('Orca chooses the workspace destination; omit --path');
        if (!values.repo) throw new Error('workspace-new requires --repo');
        if (values.orca && !values.base) throw new Error('Orca workspace creation requires --base to pin the starting ref');
        if (!values.orca && !values.path) throw new Error('Standalone workspace creation requires --path');
        const expectedVersion = Number(version);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('A positive integer version is required');
        const created = values.orca
          ? await workspaces.createOrca(id!, expectedVersion, values.repo, values.base!)
          : await workspaces.create(id!, expectedVersion, values.repo, values.path!, values.base);
        console.log(JSON.stringify(created, null, 2));
      }
      if (action === 'workspace-list') console.log(JSON.stringify(workspaces.list(), null, 2));
      if (action === 'workspace-show') console.log(JSON.stringify({ workspace: workspaces.get(id!), events: store.workspaceEvents(id!) }, null, 2));
      if (action === 'workspace-inspect') console.log(JSON.stringify(await workspaces.inspect(id!), null, 2));
      if (action === 'workspace-recover') console.log(JSON.stringify(await workspaces.recover(id!), null, 2));
    } finally { store.close(); }
    return;
  }
  if (action.startsWith('execution-')) {
    if (!['execution-new', 'execution-list', 'execution-show', 'execution-close', 'execution-snapshot', 'execution-check', 'execution-finish', 'execution-simplify', 'execution-verify', 'execution-review', 'execution-complete', 'execution-deliver', 'execution-implement', 'execution-recover'].includes(action)) throw new Error('Unknown execution command');
    if (action !== 'execution-list' && !id) throw new Error(`${action} requires an argument`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      const executions = new Executions(store);
      const checks = new Checks(store);
      if (action === 'execution-new') {
        const expectedVersion = Number(version);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('A positive integer version is required');
        const execution = await executions.create(id!, expectedVersion, positionals[3] as Provider,
          (values.role ?? 'implementation') as Execution['role'], values.model ?? null, values['fallback-reason'] ?? null);
        console.log(JSON.stringify(execution, null, 2));
      }
      if (action === 'execution-list') console.log(JSON.stringify(executions.list(), null, 2));
      if (action === 'execution-show') {
        const execution = executions.get(id!);
        console.log(JSON.stringify({ execution, session: new Sessions(store).get(execution.sessionId),
          lease: store.lease(execution.workspaceId), checks: store.checks(id!), implementations: store.implementations(id!), deliveries: store.deliveries(id!), events: store.executionEvents(id!) }, null, 2));
      }
      if (action === 'execution-close') { executions.close(id!); console.log(JSON.stringify(executions.get(id!), null, 2)); }
      if (action === 'execution-snapshot') console.log(JSON.stringify(await checks.snapshot(id!), null, 2));
      if (action === 'execution-simplify') {
        if (!version) throw new Error('execution-simplify requires an assessment file');
        const assessment = JSON.parse(readFileSync(version, 'utf8'));
        await checks.simplify(id!, assessment);
        console.log(JSON.stringify(new Workflow(store).get(executions.get(id!).taskId), null, 2));
        if (assessment.outcome !== 'passed') process.exitCode = 1;
      }
      if (action === 'execution-recover') { executions.recoverReadOnly(id!); console.log(JSON.stringify(executions.get(id!), null, 2)); }
      if (action === 'execution-complete') {
        await checks.complete(id!);
        console.log(JSON.stringify(new Workflow(store).get(executions.get(id!).taskId), null, 2));
      }
      if (action === 'execution-deliver') {
        if (!version) throw new Error('execution-deliver requires a delivery specification file');
        const abort = new AbortController(); const stop = () => abort.abort(); process.on('SIGINT', stop);
        try {
          const delivery = await new Deliveries(store).run(id!, JSON.parse(readFileSync(version, 'utf8')), abort.signal);
          console.log(JSON.stringify(delivery, null, 2));
          if (delivery.phase !== 'delivered') process.exitCode = delivery.phase === 'interrupted' ? 130 : 1;
        } finally { process.off('SIGINT', stop); }
      }
      if (action === 'execution-implement') {
        if (!version) throw new Error('execution-implement requires an edit policy file');
        const abort = new AbortController(); const stop = () => abort.abort(); process.on('SIGINT', stop);
        try {
          const result = await new Implementations(store).run(id!, JSON.parse(readFileSync(version, 'utf8')),
            values['prompt-file'] ? readFileSync(values['prompt-file'], 'utf8') : undefined,
            { signal: abort.signal, ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}),
              ...(values['answers-file'] ? { answers: JSON.parse(readFileSync(values['answers-file'], 'utf8')) } : {}) });
          console.log(JSON.stringify(result, null, 2));
          if (result.phase !== 'completed') process.exitCode = result.phase === 'interrupted' ? 130 : 1;
        } finally { process.off('SIGINT', stop); }
      }
      if (action === 'execution-finish') {
        if (!version) throw new Error('execution-finish requires a check id');
        await checks.finish(id!, version);
        console.log(JSON.stringify(new Workflow(store).get(executions.get(id!).taskId), null, 2));
      }
      if (action === 'execution-check' || action === 'execution-verify') {
        if (!version) throw new Error(`${action} requires a check specification file`);
        const spec = JSON.parse(readFileSync(version, 'utf8')) as CheckSpec;
        if ((spec.criteria !== undefined) !== (action === 'execution-verify')) throw new Error('Only execution-verify requires criteria in the specification');
        const abort = new AbortController();
        const stop = () => { console.error('Stop requested; waiting for the owned tool processes to exit.'); abort.abort(); };
        process.on('SIGINT', stop);
        try {
          const check = await checks.run(id!, spec, abort.signal);
          console.log(JSON.stringify(check, null, 2));
          if (check.phase !== 'passed') process.exitCode = check.phase === 'interrupted' ? 130 : 1;
        } finally { process.off('SIGINT', stop); }
      }
      if (action === 'execution-review') {
        const execution = executions.get(id!);
        const abort = new AbortController(); const stop = () => abort.abort();
        process.on('SIGINT', stop);
        try {
          const result = await runSession(store, execution.sessionId, 'Review the verified artifact.', { artifactReview: true, signal: abort.signal,
            ...(values['answers-file'] ? { answers: JSON.parse(readFileSync(values['answers-file'], 'utf8')) as Record<string, string> } : {}),
            ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}) });
          console.log(JSON.stringify({ session: new Sessions(store).get(execution.sessionId), result }, null, 2));
          if (result.status !== 'completed' || result.reply?.findings.some(item => item.severity === 'blocking')) process.exitCode = result.status === 'interrupted' ? 130 : 1;
        } finally { process.off('SIGINT', stop); }
      }
    } finally { store.close(); }
    return;
  }
  if (action === 'implementation-show' || action === 'implementation-recover') {
    if (!id) throw new Error(`${action} requires an id`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      const implementations = new Implementations(store);
      const result = action === 'implementation-show' ? implementations.get(id) : await implementations.recover(id);
      console.log(JSON.stringify(result, null, 2));
    } finally { store.close(); }
    return;
  }
  if (action === 'delivery-show' || action === 'delivery-recover') {
    if (!id) throw new Error(`${action} requires an id`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      const deliveries = new Deliveries(store);
      const delivery = action === 'delivery-show' ? deliveries.get(id) : await deliveries.recover(id);
      console.log(JSON.stringify(delivery, null, 2));
      if (action === 'delivery-recover' && delivery.phase !== 'delivered') process.exitCode = 1;
    } finally { store.close(); }
    return;
  }
  if (action === 'check-show' || action === 'check-recover') {
    if (!id) throw new Error(`${action} requires an id`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try { console.log(JSON.stringify(action === 'check-recover' ? new Checks(store).recover(id) : new Checks(store).get(id), null, 2)); }
    finally { store.close(); }
    return;
  }
  if (action.startsWith('session-')) {
    if (!['session-new', 'session-send', 'session-answer', 'session-show', 'session-list', 'session-recover'].includes(action)) throw new Error('Unknown session command');
    if (action !== 'session-list' && !id) throw new Error(`${action} requires an argument`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      const sessions = new Sessions(store);
      if (action === 'session-new') console.log(JSON.stringify(sessions.create(id as Provider, values.cwd ?? process.cwd(), values.model ?? null), null, 2));
      if (action === 'session-list') console.log(JSON.stringify(store.sessions(), null, 2));
      if (action === 'session-show') console.log(JSON.stringify({ session: sessions.get(id!), execution: store.executionForSession(id!), events: store.sessionEvents(id!) }, null, 2));
      if (action === 'session-recover') { sessions.recover(id!); console.log(JSON.stringify(sessions.get(id!), null, 2)); }
      if (action === 'session-send' || action === 'session-answer') {
        const abort = new AbortController();
        const stop = () => { console.error('Stop requested; waiting for the owned process to exit.'); abort.abort(); };
        process.on('SIGINT', stop);
        try {
          const prompt = values['prompt-file'] ? readFileSync(values['prompt-file'], 'utf8') : version ?? '';
          const answers = action === 'session-answer' ? JSON.parse(readFileSync(version ?? '', 'utf8')) as Record<string, string> : undefined;
          const result = await runSession(store, id!, prompt, { signal: abort.signal,
            ...(answers ? { answers } : {}),
            ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}),
            ...(values['interrupt-after-ms'] ? { interruptAfterMs: Number(values['interrupt-after-ms']) } : {}),
          });
          console.log(JSON.stringify({ session: sessions.get(id!), result }, null, 2));
          if (result.status !== 'completed') process.exitCode = result.status === 'interrupted' ? 130 : 1;
        } finally { process.off('SIGINT', stop); }
      }
    } finally { store.close(); }
    return;
  }
  if (!['create', 'approve', 'list', 'show', 'report'].includes(action)) throw new Error(`Unknown command: ${action}\n${help}`);
  if (action !== 'list' && !id) throw new Error(`${action} requires an argument`);
  const store = new Store(values.db ?? defaultDatabasePath());
  try {
    const workflow = new Workflow(store);
    switch (action) {
      case 'create': console.log(JSON.stringify(workflow.create(JSON.parse(readFileSync(id!, 'utf8')) as Brief), null, 2)); break;
      case 'approve': {
        const expectedVersion = Number(version);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) throw new Error('A positive integer version is required');
        workflow.approve(id!, expectedVersion);
        console.log(`Approved ${id} version ${expectedVersion}`);
        break;
      }
      case 'list': console.log(JSON.stringify(workflow.list().map(task => ({ id: task.id, title: task.brief.title, version: task.version, phase: task.phase })), null, 2)); break;
      case 'show': console.log(JSON.stringify({ task: workflow.get(id!), blockers: workflow.blockers(id!) }, null, 2)); break;
      case 'report': console.log(renderReport(store, id!)); break;
    }
  } finally { store.close(); }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
