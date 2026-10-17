import { test } from 'node:test';
import assert from 'node:assert/strict';
import { command, RpcProcess } from '../src/process.js';

test('commands pass arguments without shell expansion', async () => {
  const literal = '$(not-a-command); `literal` & | spaces';
  const output = await command(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(output, literal);
});

test('commands have a bounded timeout', async () => {
  await assert.rejects(command(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], 100));
});

test('commands receive EOF rather than waiting indefinitely for piped input', async () => {
  const output = await command(process.execPath, ['-e', 'process.stdin.resume(); process.stdin.on("end", () => process.stdout.write("finished"))']);
  assert.equal(output, 'finished');
});

test('RPC correlates out-of-order replies and drains notifications', async () => {
  const script = `
    const readline = require('node:readline');
    const lines = readline.createInterface({ input: process.stdin });
    lines.on('line', line => {
      const request = JSON.parse(line);
      if (!request.id) return;
      setTimeout(() => {
        console.log(JSON.stringify({ method: 'notice' }));
        console.log(JSON.stringify({ id: request.id, result: request.params }));
      }, request.params.delay);
    });
  `;
  const rpc = new RpcProcess(process.execPath, ['-e', script]);
  try {
    const [first, second] = await Promise.all([
      rpc.request('first', { delay: 30 }), rpc.request('second', { delay: 0 }),
    ]);
    assert.deepEqual(first, { delay: 30 });
    assert.deepEqual(second, { delay: 0 });
  } finally { await rpc.close(); }
});

test('RPC reports missing executables and rejects subsequent calls', async () => {
  const rpc = new RpcProcess('grampus-deliberately-missing-executable', []);
  try {
    await assert.rejects(rpc.request('initialize', {}), /ENOENT/);
    await assert.rejects(rpc.request('again', {}), /unavailable/);
  } finally { await rpc.close(); }
});

test('RPC reports malformed JSON and early child exits', async () => {
  for (const script of ['console.log("not JSON")', 'process.exit(2)']) {
    const rpc = new RpcProcess(process.execPath, ['-e', script]);
    try { await assert.rejects(rpc.request('initialize', {}), /Invalid JSON|exited/); }
    finally { await rpc.close(); }
  }
});

test('RPC timeout does not accept an unrelated result', async () => {
  const rpc = new RpcProcess(process.execPath, ['-e', 'process.stdin.resume(); console.log(JSON.stringify({ id: 999, result: true }));']);
  try { await assert.rejects(rpc.request('missing', {}, 100), /timeout/); }
  finally { await rpc.close(); }
});
