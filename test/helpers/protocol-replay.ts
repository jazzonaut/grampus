// Replays a recorded codex app-server exchange (test/fixtures/protocol/*.json) as a JSON-RPC server on
// stdio. Each client message must match the next client entry: same method, and the recorded params a
// subset of the sent ones. Server entries that follow are sent in order; a `result` answers the client
// request just matched. A mismatch is answered with an RPC error naming the step, so the adapter call
// that drifted fails with a readable message.
import { RpcProcess } from '../../src/process/process.js';
import { fileURLToPath } from 'node:url';

/** Absolute path of a protocol fixture in the source tree (tests run from dist/). */
export const protocolFixture = (name: string) =>
  fileURLToPath(new URL(`../../../test/fixtures/protocol/${name}`, import.meta.url));

const script = `
const exchange = JSON.parse(require('node:fs').readFileSync(process.argv[1], 'utf8')).exchange;
let step = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
const subset = (expected, actual) => {
  if (expected === null || typeof expected !== 'object') return expected === actual;
  if (Array.isArray(expected))
    return Array.isArray(actual) && expected.length === actual.length && expected.every((item, i) => subset(item, actual[i]));
  return actual !== null && typeof actual === 'object' && Object.keys(expected).every(key => subset(expected[key], actual[key]));
};
require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  const entry = exchange[step];
  const expected = entry && entry.client;
  if (!expected || expected.method !== message.method || !subset(expected.params ?? {}, message.params ?? {})) {
    const problem = 'Replay step ' + step + ': expected ' + (expected ? expected.method + ' ' + JSON.stringify(expected.params ?? {}) : 'no further client message') + ', received ' + message.method;
    if (message.id !== undefined) send({ id: message.id, error: { code: -32000, message: problem } });
    else process.stderr.write(problem + '\\n');
    return;
  }
  step++;
  while (exchange[step] && exchange[step].server) {
    const server = exchange[step++].server;
    send('result' in server || 'error' in server ? { id: message.id, ...server } : server);
  }
});
`;

/** Start a replay server for `fixture` (a file name under test/fixtures/protocol). */
export function replayServer(fixture: string): RpcProcess {
  return new RpcProcess(process.execPath, ['-e', script, protocolFixture(fixture)]);
}
