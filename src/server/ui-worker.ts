// Entry point of a dashboard action worker: reads one validated request from stdin and runs that action
// through the same controller as the CLI, so a dashboard restart never stops or replays work.
import { Store } from '../persistence/store.js';
import { GuidedTasks } from '../orchestration/guided/controller.js';
import { decisionKeyDigest } from '../orchestration/guided/keys.js';
import { Kickoffs } from '../orchestration/kickoff.js';
import { Sessions } from '../execution/sessions.js';
import { processLimits, serverLimits } from '../config/limits.js';
import { parseSettings, useSettings } from '../config/settings.js';
import { parseBoundary, parseJson } from '../process/boundary.js';
import { workerRequestSchema, type WorkerAction } from './api-schemas.js';
import { refreshHealthIfStale } from '../health/health.js';
import { doctor } from '../health/doctor.js';

async function perform(
  tasks: GuidedTasks,
  kickoffs: Kickoffs,
  store: Store,
  id: string,
  work: WorkerAction,
  signal: AbortSignal,
) {
  switch (work.action) {
    case 'run':
      await tasks.run(id, signal);
      return;
    case 'authorize':
      await tasks.authorize(id, signal);
      return;
    case 'assess':
      await tasks.assess(id, work.payload.outcome, work.payload.summary, signal);
      return;
    case 'answer':
      await tasks.answer(id, work.payload.answers, signal);
      return;
    case 'retry':
      await tasks.retry(id, signal);
      return;
    case 'rerun-checks':
      await tasks.rerunChecks(id, decisionKeyDigest(work.payload.expected), signal);
      return;
    case 'revise':
      await tasks.revise(id, work.payload.plan);
      return;
    case 'release-workspace':
      await tasks.releaseWorkspace(id);
      return;
    case 'recover':
      await tasks.recover(id);
      return;
    case 'plan':
      await kickoffs.send(id, work.payload.message, work.payload.answers, signal, work.payload.expected);
      return;
    case 'planner-recover':
      new Sessions(store).recover(id);
      return;
  }
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) {
    input += String(chunk);
    if (Buffer.byteLength(input) > serverLimits.requestBytes) throw new Error('Request too large');
  }
  const context = { kind: 'worker-request', source: 'dashboard worker request' } as const;
  const request = parseBoundary(workerRequestSchema, parseJson(input, context), context);
  // The dashboard passes the settings it loaded at startup; the worker never rereads config.json.
  useSettings(parseSettings(request.settings, 'the dashboard worker request'));
  const store = new Store(request.db),
    expected = request.payload.expected,
    tasks = new GuidedTasks(store, expected === undefined ? {} : { expectedState: expected }),
    kickoffs = new Kickoffs(store);
  const abort = new AbortController(),
    stop = () => abort.abort();
  const timer =
    request.action === 'plan'
      ? setInterval(() => {
          try {
            if (new Sessions(store).get(request.id).phase === 'stop_requested') abort.abort();
          } catch {
            abort.abort();
          }
        }, processLimits.stopPollMs)
      : null;
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  try {
    // Before a guided run, refresh stale integration health. It is recorded, never a gate.
    if (request.action === 'run' && request.health) await refreshHealthIfStale(store, () => doctor()).catch(() => null);
    await perform(tasks, kickoffs, store, request.id, request, abort.signal);
  } finally {
    if (timer) clearInterval(timer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    store.close();
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
