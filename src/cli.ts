import { parseArgs } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, defaultDatabasePath } from './persistence/store.js';
import { Workflow, type Brief } from './domain/workflow.js';
import { doctor } from './health/doctor.js';
import { runDemo } from './probes/demo.js';
import { renderReport } from './reporting/report.js';
import { Sessions, runSession } from './execution/sessions.js';
import type { Provider } from './providers/types.js';
import { Workspaces } from './repository/workspaces.js';
import { Executions } from './execution/executions.js';
import type { Execution } from './execution/execution-state.js';
import { Checks, type CheckSpec } from './verification/checks.js';
import { Deliveries } from './execution/deliveries.js';
import { Implementations } from './execution/implementations.js';
import { GuidedTasks } from './orchestration/guided-tasks.js';
import { guidedTaskView, renderGuidedTask } from './orchestration/guided-status.js';
import type { SimplificationAssessment } from './verification/checks.js';
import { defaultDashboardPort, updateInstallation, versionInformation, versionLabel } from './config/runtime.js';

const help = `Grampus — local agent controller
  task-revise <id> <version> <file.json>  Revise a settled recipe; retain files and require fresh approval
  task-release-workspace <id>     Release a proved-unused failed standalone reservation
  workspace-release <id>          Release unused reservation metadata without deleting files or branches

  grampus                        Open the local dashboard
  --version, -v                  Show version and build
  version [--json]               Show version, installation and data locations
  update [--source <checkout>]   Install a new snapshot from the recorded checkout (--yes)
  ui                             Open the local task dashboard (--port, optional --db)

  doctor [--orca]                 Check local interfaces; no inference calls
  demo                           Run a synthetic workflow in a fresh temporary database
  create <brief.json>             Store title, outcome, criteria[], plan and optional ordered slices[]
  approve <task-id> <version>     Approve that exact brief version
  list                           List stored tasks
  show <task-id>                  Show a task and completion blockers
  report <task-id>                Print a Markdown report from the journal
  task-new <plan.json>            Prepare a guided task; no workspace creation or inference
  task-show <task-id>             Show progress and next action (--details or --json)
  task-approve <id> <version> <digest> Approve the entire guided plan shown above
  task-run <id>                   Advance until input is needed or work stops
  task-authorize <id>             Authorize the inspected file scope and continue
  task-assess <id> --outcome passed|failed|skipped --summary <text>
                                  Record explicit simplification and continue
  task-answer <id> <answers.json> Answer pending questions and continue
  task-retry <id>                 Retry preparation, or start a fresh implementation attempt
  task-stop <id>                  Request a running guided controller to stop
  task-recover <id>               Reconcile saved results; never replay provider/Git work
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
Agent turns have no deadline by default. --timeout-ms opts into a deadline; --interrupt-after-ms exercises cancellation after turn start.
The demo remains synthetic. General provider tools and unattended scheduling remain disabled.
Native file editing requires explicit authorization.`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      db: { type: 'string' },
      orca: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
      cwd: { type: 'string' },
      model: { type: 'string' },
      'prompt-file': { type: 'string' },
      'answers-file': { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean' },
      version: { type: 'boolean', short: 'v' },
      source: { type: 'string' },
      yes: { type: 'boolean' },
      json: { type: 'boolean' },
      details: { type: 'boolean' },
      outcome: { type: 'string' },
      summary: { type: 'string' },
      repo: { type: 'string' },
      path: { type: 'string' },
      base: { type: 'string' },
      role: { type: 'string' },
      'fallback-reason': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'interrupt-after-ms': { type: 'string' },
    },
  });
  const [action = 'ui', id, version] = positionals;
  if (values.help) {
    console.log(help);
    return;
  }
  if (values.version || action === 'version') {
    const info = versionInformation();
    console.log(
      values.json
        ? JSON.stringify(info, null, 2)
        : values.version
          ? versionLabel()
          : `${versionLabel()}\nApplication: ${info.applicationRoot}\nData: ${info.dataDirectory}\nDashboard port: ${info.dashboardPort}\nNode: ${info.node} (${info.nodeExecutable})${info.build ? `\nSource: ${info.build.source}\nCommit: ${info.build.commit ?? 'unavailable'}${info.build.dirty ? ' (local changes)' : ''}\nBuilt: ${info.build.builtAt}\nSource digest: ${info.build.sourceDigest}` : ''}`,
    );
    return;
  }
  if (action === 'update') {
    await updateInstallation(values.source, values.yes);
    return;
  }
  if (action === 'ui') {
    const port = Number(values.port ?? defaultDashboardPort);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535');
    const { startUi } = await import('./server/ui-server.js');
    const ui = await startUi({ db: values.db ?? defaultDatabasePath(), port });
    console.log(
      `${versionLabel()}\nGrampus dashboard: ${ui.url}\nJournal: ${ui.store.path}\nKeep this terminal open. Ctrl+C closes the dashboard after active actions settle.`,
    );
    if (!values['no-open'] && process.platform === 'win32') {
      const { execFile } = await import('node:child_process');
      execFile('rundll32.exe', ['url.dll,FileProtocolHandler', ui.url], { windowsHide: true }, error => {
        if (error) console.error('Open the dashboard link above in your browser.');
      });
    }
    const close = () => {
      void ui
        .close()
        .then(() => {
          process.off('SIGINT', close);
          process.off('SIGTERM', close);
        })
        .catch(error => console.error(error.message));
    };
    process.on('SIGINT', close);
    process.on('SIGTERM', close);
    return;
  }
  if (action === 'doctor') {
    const capabilities = await doctor(values.orca);
    console.log(JSON.stringify({ node: process.version, platform: process.platform, capabilities }, null, 2));
    if (capabilities.some(item => item.status === 'unavailable')) process.exitCode = 1;
    return;
  }
  if (action === 'demo') {
    if (values.db) throw new Error('demo uses an isolated database; omit --db');
    const path = join(mkdtempSync(join(tmpdir(), 'grampus-demo-')), 'grampus.sqlite');
    const taskId = runDemo(path);
    const store = new Store(path);
    try {
      console.log(renderReport(store, taskId));
    } finally {
      store.close();
    }
    console.log(`\nRetained demo database: ${path}`);
    return;
  }
  if (action.startsWith('task-')) {
    const commands = [
      'task-new',
      'task-show',
      'task-revise',
      'task-release-workspace',
      'task-approve',
      'task-run',
      'task-authorize',
      'task-assess',
      'task-answer',
      'task-retry',
      'task-stop',
      'task-recover',
    ];
    if (!commands.includes(action) || !id) throw new Error('A supported guided task command and argument are required');
    const store = new Store(values.db ?? defaultDatabasePath());
    const abort = new AbortController(),
      stop = () => abort.abort();
    process.on('SIGINT', stop);
    try {
      const tasks = new GuidedTasks(store);
      let taskId = id;
      if (action === 'task-new') {
        const file = resolve(id);
        taskId = tasks.create(JSON.parse(readFileSync(file, 'utf8')), dirname(file)).id;
      } else if (action === 'task-revise') {
        const expectedVersion = Number(version);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !positionals[3])
          throw new Error('task-revise requires the current version and revised plan JSON file');
        const file = resolve(positionals[3]);
        await tasks.revise(id, JSON.parse(readFileSync(file, 'utf8')), dirname(file), expectedVersion);
      } else if (action === 'task-approve') {
        const expectedVersion = Number(version);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !positionals[3])
          throw new Error('Approval requires a positive version and the displayed plan digest');
        tasks.approve(id, expectedVersion, positionals[3]);
      } else if (action === 'task-run') await tasks.run(id, abort.signal);
      else if (action === 'task-authorize') await tasks.authorize(id, abort.signal);
      else if (action === 'task-assess')
        await tasks.assess(id, values.outcome as SimplificationAssessment['outcome'], values.summary!, abort.signal);
      else if (action === 'task-answer') {
        if (!version) throw new Error('task-answer requires an answers JSON file');
        await tasks.answer(id, JSON.parse(readFileSync(version, 'utf8')), abort.signal);
      } else if (action === 'task-retry') await tasks.retry(id, abort.signal);
      else if (action === 'task-release-workspace') await tasks.releaseWorkspace(id);
      else if (action === 'task-stop') tasks.stop(id);
      else if (action === 'task-recover') await tasks.recover(id);
      console.log(
        values.json
          ? JSON.stringify(guidedTaskView(store, taskId), null, 2)
          : renderGuidedTask(store, taskId, values.details),
      );
      const state = tasks.get(taskId);
      if (!['task-new', 'task-show', 'task-approve', 'task-stop'].includes(action)) {
        if (abort.signal.aborted || state.stopRequested) process.exitCode = 130;
        else if (['blocked', 'recovery_required'].includes(state.status)) process.exitCode = 1;
      }
    } finally {
      process.off('SIGINT', stop);
      store.close();
    }
    return;
  }
  if (action.startsWith('workspace-')) {
    if (
      ![
        'workspace-new',
        'workspace-list',
        'workspace-show',
        'workspace-inspect',
        'workspace-recover',
        'workspace-release',
      ].includes(action)
    )
      throw new Error('Unknown workspace command');
    if (action !== 'workspace-list' && !id) throw new Error(`${action} requires an argument`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      const workspaces = new Workspaces(store);
      if (action === 'workspace-new') {
        if (values.orca && values.path) throw new Error('Orca chooses the workspace destination; omit --path');
        if (!values.repo) throw new Error('workspace-new requires --repo');
        if (values.orca && !values.base)
          throw new Error('Orca workspace creation requires --base to pin the starting ref');
        if (!values.orca && !values.path) throw new Error('Standalone workspace creation requires --path');
        const expectedVersion = Number(version);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
          throw new Error('A positive integer version is required');
        const created = values.orca
          ? await workspaces.createOrca(id!, expectedVersion, values.repo, values.base!)
          : await workspaces.create(id!, expectedVersion, values.repo, values.path!, values.base);
        console.log(JSON.stringify(created, null, 2));
      }
      if (action === 'workspace-list') console.log(JSON.stringify(workspaces.list(), null, 2));
      if (action === 'workspace-show')
        console.log(JSON.stringify({ workspace: workspaces.get(id!), events: store.workspaceEvents(id!) }, null, 2));
      if (action === 'workspace-inspect') console.log(JSON.stringify(await workspaces.inspect(id!), null, 2));
      if (action === 'workspace-recover') console.log(JSON.stringify(await workspaces.recover(id!), null, 2));
      if (action === 'workspace-release') console.log(JSON.stringify(await workspaces.release(id!), null, 2));
    } finally {
      store.close();
    }
    return;
  }
  if (action.startsWith('execution-')) {
    if (
      ![
        'execution-new',
        'execution-list',
        'execution-show',
        'execution-close',
        'execution-snapshot',
        'execution-check',
        'execution-finish',
        'execution-simplify',
        'execution-verify',
        'execution-review',
        'execution-complete',
        'execution-deliver',
        'execution-implement',
        'execution-recover',
      ].includes(action)
    )
      throw new Error('Unknown execution command');
    if (action !== 'execution-list' && !id) throw new Error(`${action} requires an argument`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      const executions = new Executions(store);
      const checks = new Checks(store);
      if (action === 'execution-new') {
        const expectedVersion = Number(version);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
          throw new Error('A positive integer version is required');
        const execution = await executions.create(
          id!,
          expectedVersion,
          positionals[3] as Provider,
          (values.role ?? 'implementation') as Execution['role'],
          values.model ?? null,
          values['fallback-reason'] ?? null,
        );
        console.log(JSON.stringify(execution, null, 2));
      }
      if (action === 'execution-list') console.log(JSON.stringify(executions.list(), null, 2));
      if (action === 'execution-show') {
        const execution = executions.get(id!);
        console.log(
          JSON.stringify(
            {
              execution,
              session: new Sessions(store).get(execution.sessionId),
              lease: store.lease(execution.workspaceId),
              checks: store.checks(id!),
              implementations: store.implementations(id!),
              deliveries: store.deliveries(id!),
              events: store.executionEvents(id!),
            },
            null,
            2,
          ),
        );
      }
      if (action === 'execution-close') {
        executions.close(id!);
        console.log(JSON.stringify(executions.get(id!), null, 2));
      }
      if (action === 'execution-snapshot') console.log(JSON.stringify(await checks.snapshot(id!), null, 2));
      if (action === 'execution-simplify') {
        if (!version) throw new Error('execution-simplify requires an assessment file');
        const assessment = JSON.parse(readFileSync(version, 'utf8'));
        await checks.simplify(id!, assessment);
        console.log(JSON.stringify(new Workflow(store).get(executions.get(id!).taskId), null, 2));
        if (assessment.outcome !== 'passed') process.exitCode = 1;
      }
      if (action === 'execution-recover') {
        executions.recoverReadOnly(id!);
        console.log(JSON.stringify(executions.get(id!), null, 2));
      }
      if (action === 'execution-complete') {
        await checks.complete(id!);
        console.log(JSON.stringify(new Workflow(store).get(executions.get(id!).taskId), null, 2));
      }
      if (action === 'execution-deliver') {
        if (!version) throw new Error('execution-deliver requires a delivery specification file');
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.on('SIGINT', stop);
        try {
          const delivery = await new Deliveries(store).run(
            id!,
            JSON.parse(readFileSync(version, 'utf8')),
            abort.signal,
          );
          console.log(JSON.stringify(delivery, null, 2));
          if (delivery.phase !== 'delivered') process.exitCode = delivery.phase === 'interrupted' ? 130 : 1;
        } finally {
          process.off('SIGINT', stop);
        }
      }
      if (action === 'execution-implement') {
        if (!version) throw new Error('execution-implement requires an edit policy file');
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.on('SIGINT', stop);
        try {
          const result = await new Implementations(store).run(
            id!,
            JSON.parse(readFileSync(version, 'utf8')),
            values['prompt-file'] ? readFileSync(values['prompt-file'], 'utf8') : undefined,
            {
              signal: abort.signal,
              ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}),
              ...(values['answers-file'] ? { answers: JSON.parse(readFileSync(values['answers-file'], 'utf8')) } : {}),
            },
          );
          console.log(JSON.stringify(result, null, 2));
          if (result.phase !== 'completed') process.exitCode = result.phase === 'interrupted' ? 130 : 1;
        } finally {
          process.off('SIGINT', stop);
        }
      }
      if (action === 'execution-finish') {
        if (!version) throw new Error('execution-finish requires a check id');
        await checks.finish(id!, version);
        console.log(JSON.stringify(new Workflow(store).get(executions.get(id!).taskId), null, 2));
      }
      if (action === 'execution-check' || action === 'execution-verify') {
        if (!version) throw new Error(`${action} requires a check specification file`);
        const spec = JSON.parse(readFileSync(version, 'utf8')) as CheckSpec;
        if ((spec.criteria !== undefined) !== (action === 'execution-verify'))
          throw new Error('Only execution-verify requires criteria in the specification');
        const abort = new AbortController();
        const stop = () => {
          console.error('Stop requested; waiting for the owned tool processes to exit.');
          abort.abort();
        };
        process.on('SIGINT', stop);
        try {
          const check = await checks.run(id!, spec, abort.signal);
          console.log(JSON.stringify(check, null, 2));
          if (check.phase !== 'passed') process.exitCode = check.phase === 'interrupted' ? 130 : 1;
        } finally {
          process.off('SIGINT', stop);
        }
      }
      if (action === 'execution-review') {
        const execution = executions.get(id!);
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.on('SIGINT', stop);
        try {
          const result = await runSession(store, execution.sessionId, 'Review the verified artifact.', {
            artifactReview: true,
            signal: abort.signal,
            ...(values['answers-file']
              ? { answers: JSON.parse(readFileSync(values['answers-file'], 'utf8')) as Record<string, string> }
              : {}),
            ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}),
          });
          console.log(JSON.stringify({ session: new Sessions(store).get(execution.sessionId), result }, null, 2));
          if (result.status !== 'completed' || result.reply?.findings.some(item => item.severity === 'blocking'))
            process.exitCode = result.status === 'interrupted' ? 130 : 1;
        } finally {
          process.off('SIGINT', stop);
        }
      }
    } finally {
      store.close();
    }
    return;
  }
  if (action === 'implementation-show' || action === 'implementation-recover') {
    if (!id) throw new Error(`${action} requires an id`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      const implementations = new Implementations(store);
      const result = action === 'implementation-show' ? implementations.get(id) : await implementations.recover(id);
      console.log(JSON.stringify(result, null, 2));
    } finally {
      store.close();
    }
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
    } finally {
      store.close();
    }
    return;
  }
  if (action === 'check-show' || action === 'check-recover') {
    if (!id) throw new Error(`${action} requires an id`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      console.log(
        JSON.stringify(action === 'check-recover' ? new Checks(store).recover(id) : new Checks(store).get(id), null, 2),
      );
    } finally {
      store.close();
    }
    return;
  }
  if (action.startsWith('session-')) {
    if (
      !['session-new', 'session-send', 'session-answer', 'session-show', 'session-list', 'session-recover'].includes(
        action,
      )
    )
      throw new Error('Unknown session command');
    if (action !== 'session-list' && !id) throw new Error(`${action} requires an argument`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      const sessions = new Sessions(store);
      if (action === 'session-new')
        console.log(
          JSON.stringify(sessions.create(id as Provider, values.cwd ?? process.cwd(), values.model ?? null), null, 2),
        );
      if (action === 'session-list') console.log(JSON.stringify(store.sessions(), null, 2));
      if (action === 'session-show')
        console.log(
          JSON.stringify(
            { session: sessions.get(id!), execution: store.executionForSession(id!), events: store.sessionEvents(id!) },
            null,
            2,
          ),
        );
      if (action === 'session-recover') {
        sessions.recover(id!);
        console.log(JSON.stringify(sessions.get(id!), null, 2));
      }
      if (action === 'session-send' || action === 'session-answer') {
        const abort = new AbortController();
        const stop = () => {
          console.error('Stop requested; waiting for the owned process to exit.');
          abort.abort();
        };
        process.on('SIGINT', stop);
        try {
          const prompt = values['prompt-file'] ? readFileSync(values['prompt-file'], 'utf8') : (version ?? '');
          const answers =
            action === 'session-answer'
              ? (JSON.parse(readFileSync(version ?? '', 'utf8')) as Record<string, string>)
              : undefined;
          const result = await runSession(store, id!, prompt, {
            signal: abort.signal,
            ...(answers ? { answers } : {}),
            ...(values['timeout-ms'] ? { timeoutMs: Number(values['timeout-ms']) } : {}),
            ...(values['interrupt-after-ms'] ? { interruptAfterMs: Number(values['interrupt-after-ms']) } : {}),
          });
          console.log(JSON.stringify({ session: sessions.get(id!), result }, null, 2));
          if (result.status !== 'completed') process.exitCode = result.status === 'interrupted' ? 130 : 1;
        } finally {
          process.off('SIGINT', stop);
        }
      }
    } finally {
      store.close();
    }
    return;
  }
  if (!['create', 'approve', 'list', 'show', 'report'].includes(action))
    throw new Error(`Unknown command: ${action}\n${help}`);
  if (action !== 'list' && !id) throw new Error(`${action} requires an argument`);
  const store = new Store(values.db ?? defaultDatabasePath());
  try {
    const workflow = new Workflow(store);
    switch (action) {
      case 'create':
        console.log(JSON.stringify(workflow.create(JSON.parse(readFileSync(id!, 'utf8')) as Brief), null, 2));
        break;
      case 'approve': {
        const expectedVersion = Number(version);
        if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1)
          throw new Error('A positive integer version is required');
        workflow.approve(id!, expectedVersion);
        console.log(`Approved ${id} version ${expectedVersion}`);
        break;
      }
      case 'list':
        console.log(
          JSON.stringify(
            workflow
              .list()
              .map(task => ({ id: task.id, title: task.brief.title, version: task.version, phase: task.phase })),
            null,
            2,
          ),
        );
        break;
      case 'show':
        console.log(JSON.stringify({ task: workflow.get(id!), blockers: workflow.blockers(id!) }, null, 2));
        break;
      case 'report':
        console.log(renderReport(store, id!));
        break;
    }
  } finally {
    store.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
