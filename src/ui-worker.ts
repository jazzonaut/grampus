import { Store } from './store.js';
import { GuidedTasks } from './guided-tasks.js';
import { Kickoffs } from './kickoff.js';
import { Sessions } from './sessions.js';

async function main() {
  let input = '';
  for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 1024 * 1024) throw new Error('Request too large'); }
  const { db, id, action, payload } = JSON.parse(input);
  const store = new Store(db), tasks = new GuidedTasks(store, { expectedState: payload.expected }), kickoffs = new Kickoffs(store);
  const abort = new AbortController(), stop = () => abort.abort();
  const timer = action === 'plan' ? setInterval(() => {
    try { if (new Sessions(store).get(id).phase === 'stop_requested') abort.abort(); } catch { abort.abort(); }
  }, 250) : null;
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  try {
    switch (action) {
      case 'run': await tasks.run(id, abort.signal); break;
      case 'authorize': await tasks.authorize(id, abort.signal); break;
      case 'assess': await tasks.assess(id, payload.outcome, payload.summary, abort.signal); break;
      case 'answer': await tasks.answer(id, payload.answers, abort.signal); break;
      case 'retry': await tasks.retry(id, abort.signal); break;
      case 'recover': await tasks.recover(id); break;
      case 'plan': await kickoffs.send(id, payload.message, payload.answers, abort.signal, payload.expected); break;
      case 'planner-recover': new Sessions(store).recover(id); break;
      default: throw new Error('Unknown worker action');
    }
  } finally { if (timer) clearInterval(timer); process.off('SIGINT', stop); process.off('SIGTERM', stop); store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
