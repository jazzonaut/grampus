// Owns the command line: option parsing, dispatch to the controller and Ctrl+C handling. Option values
// and JSON input files are validated by cli-input.ts before any command touches the journal.
import { parseArgs } from 'node:util';
import { mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Store, defaultDatabasePath } from './persistence/store.js';
import { Workflow } from './domain/workflow.js';
import { doctor } from './health/doctor.js';
import { runDemo } from './probes/demo.js';
import { renderReport } from './reporting/report.js';
import { Sessions, runSession } from './execution/sessions.js';
import { Workspaces } from './repository/workspaces.js';
import { Executions } from './execution/executions.js';
import { Checks } from './verification/checks.js';
import { Deliveries } from './execution/deliveries.js';
import { Implementations } from './execution/implementations.js';
import { GuidedTasks } from './orchestration/guided-tasks.js';
import { guidedTaskView, renderGuidedTask } from './orchestration/guided-status.js';
import { defaultDataDirectory, updateInstallation, versionInformation, versionLabel } from './config/runtime.js';
import { currentSettings, loadSettings, useSettings } from './config/settings.js';
import {
  answersFile,
  assessmentFile,
  assessmentOutcome,
  briefFile,
  checkSpecFile,
  deliverySpecFile,
  editPolicyFile,
  executionRole,
  milliseconds,
  port,
  positiveInteger,
  provider,
  readJsonFile,
  requiredText,
} from './cli-input.js';

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

const options = {
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
} as const;

/** One parsed invocation: the command, its positional arguments and option values. */
interface Invocation {
  action: string;
  /** The first positional argument after the command, if any. */
  id: string | undefined;
  /** The second positional argument after the command, if any. */
  second: string | undefined;
  positionals: string[];
  values: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>['values'];
}

/** The first argument of a command that requires one. */
function argument(invocation: Invocation, what = 'an argument'): string {
  if (!invocation.id) throw new Error(`${invocation.action} requires ${what}`);
  return invocation.id;
}

function openStore(invocation: Invocation): Store {
  return new Store(invocation.values.db ?? defaultDatabasePath());
}

async function withStore<T>(invocation: Invocation, action: (store: Store) => Promise<T> | T): Promise<T> {
  const store = openStore(invocation);
  try {
    return await action(store);
  } finally {
    store.close();
  }
}

/** Run `action` with an abort signal that Ctrl+C triggers. */
async function interruptible<T>(action: (signal: AbortSignal) => Promise<T>, notice?: string): Promise<T> {
  const abort = new AbortController();
  const stop = () => {
    if (notice) console.error(notice);
    abort.abort();
  };
  process.on('SIGINT', stop);
  try {
    return await action(abort.signal);
  } finally {
    process.off('SIGINT', stop);
  }
}

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
const exitFor = (phase: string, success: string) => {
  if (phase !== success) process.exitCode = phase === 'interrupted' ? 130 : 1;
};

function timeoutOption(invocation: Invocation): { timeoutMs?: number } {
  const value = invocation.values['timeout-ms'];
  return value ? { timeoutMs: milliseconds(value, 'timeout-ms') } : {};
}

function versionCommand(invocation: Invocation): void {
  const { values } = invocation;
  const info = versionInformation(currentSettings().dashboardPort);
  console.log(
    values.json
      ? JSON.stringify(info, null, 2)
      : values.version
        ? versionLabel()
        : `${versionLabel()}\nApplication: ${info.applicationRoot}\nData: ${info.dataDirectory}\nDashboard port: ${info.dashboardPort}\nNode: ${info.node} (${info.nodeExecutable})${info.build ? `\nSource: ${info.build.source}\nCommit: ${info.build.commit ?? 'unavailable'}${info.build.dirty ? ' (local changes)' : ''}\nBuilt: ${info.build.builtAt}\nSource digest: ${info.build.sourceDigest}` : ''}`,
  );
}

async function uiCommand(invocation: Invocation): Promise<void> {
  const { values } = invocation;
  const listen = port(values.port ?? String(currentSettings().dashboardPort));
  const { startUi } = await import('./server/ui-server.js');
  const ui = await startUi({ db: values.db ?? defaultDatabasePath(), port: listen });
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
      .catch((error: unknown) => console.error(error instanceof Error ? error.message : String(error)));
  };
  process.on('SIGINT', close);
  process.on('SIGTERM', close);
}

function demoCommand(invocation: Invocation): void {
  if (invocation.values.db) throw new Error('demo uses an isolated database; omit --db');
  const path = join(mkdtempSync(join(tmpdir(), 'grampus-demo-')), 'grampus.sqlite');
  const taskId = runDemo(path);
  const store = new Store(path);
  try {
    console.log(renderReport(store, taskId));
  } finally {
    store.close();
  }
  console.log(`\nRetained demo database: ${path}`);
}

const taskCommands = [
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

async function guidedTaskAction(invocation: Invocation, tasks: GuidedTasks, signal: AbortSignal): Promise<string> {
  const { action, values, positionals, second } = invocation;
  const id = argument(invocation);
  switch (action) {
    case 'task-new': {
      const file = resolve(id);
      return tasks.create(readJsonFile(file), dirname(file)).id;
    }
    case 'task-revise': {
      const message = 'task-revise requires the current version and revised plan JSON file';
      const expectedVersion = positiveInteger(second, message);
      const plan = positionals[3];
      if (!plan) throw new Error(message);
      const file = resolve(plan);
      await tasks.revise(id, readJsonFile(file), dirname(file), expectedVersion);
      return id;
    }
    case 'task-approve': {
      const message = 'Approval requires a positive version and the displayed plan digest';
      const expectedVersion = positiveInteger(second, message);
      const digest = positionals[3];
      if (!digest) throw new Error(message);
      tasks.approve(id, expectedVersion, digest);
      return id;
    }
    case 'task-run':
      await tasks.run(id, signal);
      return id;
    case 'task-authorize':
      await tasks.authorize(id, signal);
      return id;
    case 'task-assess':
      await tasks.assess(id, assessmentOutcome(values.outcome), requiredText(values.summary, 'summary'), signal);
      return id;
    case 'task-answer':
      if (!second) throw new Error('task-answer requires an answers JSON file');
      await tasks.answer(id, answersFile(second), signal);
      return id;
    case 'task-retry':
      await tasks.retry(id, signal);
      return id;
    case 'task-release-workspace':
      await tasks.releaseWorkspace(id);
      return id;
    case 'task-stop':
      tasks.stop(id);
      return id;
    case 'task-recover':
      await tasks.recover(id);
      return id;
    default:
      return id;
  }
}

async function taskCommand(invocation: Invocation): Promise<void> {
  const { action, values } = invocation;
  if (!taskCommands.includes(action) || !invocation.id)
    throw new Error('A supported guided task command and argument are required');
  await withStore(invocation, store =>
    interruptible(async signal => {
      const tasks = new GuidedTasks(store);
      const taskId = await guidedTaskAction(invocation, tasks, signal);
      console.log(
        values.json
          ? JSON.stringify(guidedTaskView(store, taskId), null, 2)
          : renderGuidedTask(store, taskId, values.details),
      );
      const state = tasks.get(taskId);
      if (!['task-new', 'task-show', 'task-approve', 'task-stop'].includes(action)) {
        if (signal.aborted || state.stopRequested) process.exitCode = 130;
        else if (['blocked', 'recovery_required'].includes(state.status)) process.exitCode = 1;
      }
    }),
  );
}

async function workspaceCommand(invocation: Invocation): Promise<void> {
  const { action, values } = invocation;
  const commands = [
    'workspace-new',
    'workspace-list',
    'workspace-show',
    'workspace-inspect',
    'workspace-recover',
    'workspace-release',
  ];
  if (!commands.includes(action)) throw new Error('Unknown workspace command');
  if (action === 'workspace-list') {
    await withStore(invocation, store => print(new Workspaces(store).list()));
    return;
  }
  const id = argument(invocation);
  await withStore(invocation, async store => {
    const workspaces = new Workspaces(store);
    if (action === 'workspace-new') {
      if (values.orca && values.path) throw new Error('Orca chooses the workspace destination; omit --path');
      if (!values.repo) throw new Error('workspace-new requires --repo');
      const expectedVersion = positiveInteger(invocation.second, 'A positive integer version is required');
      if (values.orca) {
        if (!values.base) throw new Error('Orca workspace creation requires --base to pin the starting ref');
        print(await workspaces.createOrca(id, expectedVersion, values.repo, values.base));
      } else {
        if (!values.path) throw new Error('Standalone workspace creation requires --path');
        print(await workspaces.create(id, expectedVersion, values.repo, values.path, values.base));
      }
    }
    if (action === 'workspace-show') print({ workspace: workspaces.get(id), events: store.workspaceEvents(id) });
    if (action === 'workspace-inspect') print(await workspaces.inspect(id));
    if (action === 'workspace-recover') print(await workspaces.recover(id));
    if (action === 'workspace-release') print(await workspaces.release(id));
  });
}

const executionCommands = [
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
];

/** The JSON file argument of an execution command. */
function inputFile(invocation: Invocation, what: string): string {
  if (!invocation.second) throw new Error(`${invocation.action} requires ${what}`);
  return invocation.second;
}

async function runExecutionWork(invocation: Invocation, store: Store, id: string): Promise<void> {
  const { action, values } = invocation;
  const workflow = new Workflow(store),
    executions = new Executions(store),
    checks = new Checks(store);
  const showTask = () => print(workflow.get(executions.get(id).taskId));
  switch (action) {
    case 'execution-simplify': {
      const assessment = assessmentFile(inputFile(invocation, 'an assessment file'));
      await checks.simplify(id, assessment);
      showTask();
      if (assessment.outcome !== 'passed') process.exitCode = 1;
      return;
    }
    case 'execution-complete':
      await checks.complete(id);
      showTask();
      return;
    case 'execution-finish':
      await checks.finish(id, inputFile(invocation, 'a check id'));
      showTask();
      return;
    case 'execution-deliver': {
      const spec = deliverySpecFile(inputFile(invocation, 'a delivery specification file'));
      const delivery = await interruptible(signal => new Deliveries(store).run(id, spec, signal));
      print(delivery);
      exitFor(delivery.phase, 'delivered');
      return;
    }
    case 'execution-implement': {
      const policy = editPolicyFile(inputFile(invocation, 'an edit policy file'));
      const promptFile = values['prompt-file'];
      const answers = values['answers-file'];
      const result = await interruptible(signal =>
        new Implementations(store).run(id, policy, promptFile ? readFileSync(promptFile, 'utf8') : undefined, {
          signal,
          ...timeoutOption(invocation),
          ...(answers ? { answers: answersFile(answers) } : {}),
        }),
      );
      print(result);
      exitFor(result.phase, 'completed');
      return;
    }
    case 'execution-check':
    case 'execution-verify': {
      const spec = checkSpecFile(inputFile(invocation, 'a check specification file'));
      if ((spec.criteria !== undefined) !== (action === 'execution-verify'))
        throw new Error('Only execution-verify requires criteria in the specification');
      const check = await interruptible(
        signal => checks.run(id, spec, signal),
        'Stop requested; waiting for the owned tool processes to exit.',
      );
      print(check);
      exitFor(check.phase, 'passed');
      return;
    }
    case 'execution-review': {
      const execution = executions.get(id);
      const answers = values['answers-file'];
      const result = await interruptible(signal =>
        runSession(store, execution.sessionId, 'Review the verified artifact.', {
          artifactReview: true,
          signal,
          ...(answers ? { answers: answersFile(answers) } : {}),
          ...timeoutOption(invocation),
        }),
      );
      print({ session: new Sessions(store).get(execution.sessionId), result });
      if (result.status !== 'completed' || result.reply?.findings.some(item => item.severity === 'blocking'))
        process.exitCode = result.status === 'interrupted' ? 130 : 1;
      return;
    }
  }
}

async function executionCommand(invocation: Invocation): Promise<void> {
  const { action, values } = invocation;
  if (!executionCommands.includes(action)) throw new Error('Unknown execution command');
  if (action === 'execution-list') {
    await withStore(invocation, store => print(new Executions(store).list()));
    return;
  }
  const id = argument(invocation);
  await withStore(invocation, async store => {
    const executions = new Executions(store);
    switch (action) {
      case 'execution-new':
        print(
          await executions.create(
            id,
            positiveInteger(invocation.second, 'A positive integer version is required'),
            provider(invocation.positionals[3]),
            executionRole(values.role),
            values.model ?? null,
            values['fallback-reason'] ?? null,
          ),
        );
        return;
      case 'execution-show': {
        const execution = executions.get(id);
        print({
          execution,
          session: new Sessions(store).get(execution.sessionId),
          lease: store.lease(execution.workspaceId),
          checks: store.checks(id),
          implementations: store.implementations(id),
          deliveries: store.deliveries(id),
          events: store.executionEvents(id),
        });
        return;
      }
      case 'execution-close':
        executions.close(id);
        print(executions.get(id));
        return;
      case 'execution-snapshot':
        print(await new Checks(store).snapshot(id));
        return;
      case 'execution-recover':
        executions.recoverReadOnly(id);
        print(executions.get(id));
        return;
      default:
        await runExecutionWork(invocation, store, id);
    }
  });
}

async function recordCommand(invocation: Invocation): Promise<void> {
  const { action } = invocation;
  const id = argument(invocation, 'an id');
  await withStore(invocation, async store => {
    if (action === 'implementation-show' || action === 'implementation-recover') {
      const implementations = new Implementations(store);
      print(action === 'implementation-show' ? implementations.get(id) : await implementations.recover(id));
    } else if (action === 'delivery-show' || action === 'delivery-recover') {
      const deliveries = new Deliveries(store);
      const delivery = action === 'delivery-show' ? deliveries.get(id) : await deliveries.recover(id);
      print(delivery);
      if (action === 'delivery-recover' && delivery.phase !== 'delivered') process.exitCode = 1;
    } else {
      const checks = new Checks(store);
      print(action === 'check-recover' ? checks.recover(id) : checks.get(id));
    }
  });
}

async function sessionCommand(invocation: Invocation): Promise<void> {
  const { action, values } = invocation;
  const commands = ['session-new', 'session-send', 'session-answer', 'session-show', 'session-list', 'session-recover'];
  if (!commands.includes(action)) throw new Error('Unknown session command');
  if (action === 'session-list') {
    await withStore(invocation, store => print(store.sessions()));
    return;
  }
  const id = argument(invocation);
  await withStore(invocation, async store => {
    const sessions = new Sessions(store);
    if (action === 'session-new')
      print(sessions.create(provider(id, 'session provider'), values.cwd ?? process.cwd(), values.model ?? null));
    if (action === 'session-show')
      print({ session: sessions.get(id), execution: store.executionForSession(id), events: store.sessionEvents(id) });
    if (action === 'session-recover') {
      sessions.recover(id);
      print(sessions.get(id));
    }
    if (action === 'session-send' || action === 'session-answer') {
      const promptFile = values['prompt-file'];
      const prompt = promptFile ? readFileSync(promptFile, 'utf8') : (invocation.second ?? '');
      const answers = action === 'session-answer' ? answersFile(invocation.second ?? '') : undefined;
      const interruptAfter = values['interrupt-after-ms'];
      const result = await interruptible(
        signal =>
          runSession(store, id, prompt, {
            signal,
            ...(answers ? { answers } : {}),
            ...timeoutOption(invocation),
            ...(interruptAfter ? { interruptAfterMs: milliseconds(interruptAfter, 'interrupt-after-ms') } : {}),
          }),
        'Stop requested; waiting for the owned process to exit.',
      );
      print({ session: sessions.get(id), result });
      if (result.status !== 'completed') process.exitCode = result.status === 'interrupted' ? 130 : 1;
    }
  });
}

async function briefCommand(invocation: Invocation): Promise<void> {
  const { action } = invocation;
  if (!['create', 'approve', 'list', 'show', 'report'].includes(action))
    throw new Error(`Unknown command: ${action}\n${help}`);
  await withStore(invocation, store => {
    const workflow = new Workflow(store);
    if (action === 'list') {
      print(
        workflow
          .list()
          .map(task => ({ id: task.id, title: task.brief.title, version: task.version, phase: task.phase })),
      );
      return;
    }
    const id = argument(invocation);
    switch (action) {
      case 'create':
        print(workflow.create(briefFile(id)));
        break;
      case 'approve': {
        const expectedVersion = positiveInteger(invocation.second, 'A positive integer version is required');
        workflow.approve(id, expectedVersion);
        console.log(`Approved ${id} version ${expectedVersion}`);
        break;
      }
      case 'show':
        print({ task: workflow.get(id), blockers: workflow.blockers(id) });
        break;
      case 'report':
        console.log(renderReport(store, id));
        break;
    }
  });
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options });
  const [action = 'ui', id, second] = positionals;
  const invocation: Invocation = { action, id, second, positionals, values };
  if (values.help) {
    console.log(help);
    return;
  }
  // Loaded once per launch; workers started from here receive these values instead of rereading the file.
  // An update never depends on settings, so an invalid config.json cannot block installing a fix.
  if (action !== 'update') useSettings(loadSettings(defaultDataDirectory()));
  if (values.version || action === 'version') versionCommand(invocation);
  else if (action === 'update') await updateInstallation(values.source, values.yes);
  else if (action === 'ui') await uiCommand(invocation);
  else if (action === 'doctor') {
    const capabilities = await doctor(values.orca);
    print({ node: process.version, platform: process.platform, capabilities });
    if (capabilities.some(item => item.status === 'unavailable')) process.exitCode = 1;
  } else if (action === 'demo') demoCommand(invocation);
  else if (action.startsWith('task-')) await taskCommand(invocation);
  else if (action.startsWith('workspace-')) await workspaceCommand(invocation);
  else if (action.startsWith('execution-')) await executionCommand(invocation);
  else if (
    [
      'implementation-show',
      'implementation-recover',
      'delivery-show',
      'delivery-recover',
      'check-show',
      'check-recover',
    ].includes(action)
  )
    await recordCommand(invocation);
  else if (action.startsWith('session-')) await sessionCommand(invocation);
  else await briefCommand(invocation);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
