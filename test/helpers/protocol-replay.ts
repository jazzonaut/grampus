// Replays a recorded codex app-server exchange (test/fixtures/protocol/*.json) as a JSON-RPC server on
// stdio. Each client message must match the next client entry: same method, and the recorded params a
// subset of the sent ones. A client entry without a method is the client's response to a server request:
// its recorded `id`, `result` or `error` must be a subset of the response. Server entries that follow are
// sent in order; a `result` answers the client request just matched, and an entry with both `id` and
// `method` is a server request. A mismatch is answered with an RPC error naming the step, so the adapter
// call that drifted fails with a readable message.
import { isAbsolute } from 'node:path';
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
  const matches =
    expected &&
    expected.method === message.method &&
    (message.method === undefined ? subset(expected, message) : subset(expected.params ?? {}, message.params ?? {}));
  if (!matches) {
    const received = message.method ?? 'a response to ' + JSON.stringify(message.id) + ' ' + JSON.stringify(message);
    const problem = 'Replay step ' + step + ': expected ' + (expected ? (expected.method ?? 'a response') + ' ' + JSON.stringify(expected.params ?? expected) : 'no further client message') + ', received ' + received;
    if (message.method && message.id !== undefined) send({ id: message.id, error: { code: -32000, message: problem } });
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

/** Start a replay server for `fixture`: a file name under test/fixtures/protocol, or an absolute path. */
export function replayServer(fixture: string): RpcProcess {
  return new RpcProcess(process.execPath, ['-e', script, isAbsolute(fixture) ? fixture : protocolFixture(fixture)]);
}
