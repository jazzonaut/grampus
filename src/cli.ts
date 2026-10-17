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

const help = `Grampus — local agent controller

  doctor [--orca]                 Check local interfaces; no inference calls
  demo                           Run a synthetic workflow in a fresh temporary database
  create <brief.json>             Store a brief with title, outcome, criteria[], plan
  approve <task-id> <version>     Approve that exact brief version
  list                           List stored tasks
  show <task-id>                  Show a task and completion blockers
  report <task-id>                Print a Markdown report from the journal
  session-new <codex|claude>      Create a conversation (--cwd, optional --model)
  session-send <id> <prompt>      Run one live turn (or use --prompt-file <path>)
  session-answer <id> <file.json> Answer pending question ids with a JSON object
  session-show <id>              Show saved identity, state, and session events
  session-list                   List conversations
  session-recover <id>           Reconcile only when recorded processes have exited

Use --db <path> for persistent task commands, or GRAMPUS_HOME for the data directory.
Live sessions use existing subscriptions. Ctrl+C requests interruption and waits for process exit.
--timeout-ms defaults to 120000; --interrupt-after-ms exercises cancellation after turn start.
The demo remains synthetic. Repository execution and scheduling are not implemented yet.`;

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { db: { type: 'string' }, orca: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h' },
      cwd: { type: 'string' }, model: { type: 'string' }, 'prompt-file': { type: 'string' },
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
  if (action.startsWith('session-')) {
    if (!['session-new', 'session-send', 'session-answer', 'session-show', 'session-list', 'session-recover'].includes(action)) throw new Error('Unknown session command');
    if (action !== 'session-list' && !id) throw new Error(`${action} requires an argument`);
    const store = new Store(values.db ?? defaultDatabasePath());
    try {
      const sessions = new Sessions(store);
      if (action === 'session-new') console.log(JSON.stringify(sessions.create(id as Provider, values.cwd ?? process.cwd(), values.model ?? null), null, 2));
      if (action === 'session-list') console.log(JSON.stringify(store.sessions(), null, 2));
      if (action === 'session-show') console.log(JSON.stringify({ session: sessions.get(id!), events: store.sessionEvents(id!) }, null, 2));
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
