import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RpcProcess } from '../src/process.js';
import { CodexSession } from '../src/agents/codex.js';
import type { AgentEvent } from '../src/agents/types.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { EditingContext } from '../src/edit-policy.js';
import type { RepositoryAccess } from '../src/repository-tools.js';

const reply = { kind: 'message', text: 'fixture', questions: [], findings: [] };
function fixture(
  behavior: string,
  events: AgentEvent[] = [],
  onEvent: (event: AgentEvent) => void = () => {},
  editing?: EditingContext,
  repository?: RepositoryAccess,
) {
  const script = `
    const send = value => console.log(JSON.stringify(value));
    const reply = ${JSON.stringify(reply)};
    const note = (method, params) => send({ method, params: { threadId: 'thread-1', ...params } });
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const r = JSON.parse(line);
      if (r.method === 'mcpServerStatus/list') { send({ id: r.id, result: { data: [{ name: 'fixture', runtimeStatus: 'ready', tools: { read: {} }, authStatus: 'notLoggedIn' }], nextCursor: null } }); return; }
      ${behavior}
    });
  `;
  const rpc = new RpcProcess(process.execPath, ['-e', script]);
  return new CodexSession(
    rpc,
    'thread-1',
    event => {
      events.push(event);
      onEvent(event);
    },
    editing,
    repository,
  );
}

test('Codex repository calls are bound to the current thread and turn, journaled, and cannot grant writes', async t => {
  const context = editingFixture(t);
  context.snapshot.files[0]!.sha256 = createHash('sha256').update('before\n').digest('hex');
  const events: AgentEvent[] = [];
  const agent = fixture(
    `
    if (r.method === 'turn/start') {
      note('turn/started', { turn: { id: 'turn-1' } });
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
      send({ id: 'read', method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'read-1', tool: 'grampus_read_file', arguments: { path: 'file.txt' } } });
    }
    if (r.id === 'read') {
      if (!r.result?.success || !r.result.contentItems[0].text.includes('before')) process.exit(3);
      send({ id: 'duplicate', method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'read-1', tool: 'grampus_read_file', arguments: { path: 'file.txt' } } });
    }
    if (r.id === 'duplicate') {
      if (r.result?.success !== false) process.exit(4);
      send({ id: 'foreign', method: 'item/tool/call', params: { threadId: 'other', turnId: 'turn-1', callId: 'read-2', tool: 'grampus_read_file', arguments: { path: 'file.txt' } } });
    }
    if (r.id === 'foreign') {
      if (r.result?.success !== false) process.exit(5);
      send({ id: 'write', method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'write-1', tool: 'Write', arguments: { path: 'file.txt' } } });
    }
    if (r.id === 'write') {
      if (r.result?.success !== false) process.exit(6);
      note('item/completed', { item: { type: 'agentMessage', text: JSON.stringify(reply) } });
      note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    }
  `,
    events,
    undefined,
    undefined,
    { repo: context.cwd, snapshot: context.snapshot },
  );
  try {
    assert.equal((await agent.turn('Read')).status, 'completed');
  } finally {
    await agent.close();
  }
  assert.equal(events.filter(event => event.type === 'repository.tool_result').length, 1);
  assert.deepEqual(events.find(event => event.type === 'integrations.updated')?.data, {
    servers: [{ name: 'fixture', status: 'ready', tools: 1, auth: 'notLoggedIn' }],
  });
});

test('Codex serves paginated snapshot changes through its owned dynamic tool transport', async t => {
  const context = editingFixture(t),
    events: AgentEvent[] = [];
  context.snapshot.diff = [
    {
      path: 'file.txt',
      before: 'a'.repeat(40),
      after: 'b'.repeat(40),
      encoding: 'utf8',
      content: 'after',
      previousEncoding: 'utf8',
      previousContent: 'before',
    },
  ];
  const agent = fixture(
    `
    if (r.method === 'turn/start') {
      note('turn/started', { turn: { id: 'turn-1' } });
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
      send({ id: 'changes', method: 'item/tool/call', params: { threadId: 'thread-1', turnId: 'turn-1', callId: 'changes-1', tool: 'grampus_read_changes', arguments: { path: 'file.txt', side: 'before', limit: 3 } } });
    }
    if (r.id === 'changes') {
      const page = JSON.parse(r.result.contentItems[0].text);
      if (!r.result.success || page.content !== 'bef' || page.nextOffset !== 3) process.exit(3);
      note('item/completed', { item: { type: 'agentMessage', text: JSON.stringify(reply) } });
      note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    }
  `,
    events,
    undefined,
    undefined,
    { repo: context.cwd, snapshot: context.snapshot },
  );
  try {
    assert.equal((await agent.turn('Inspect the original change')).status, 'completed');
  } finally {
    await agent.close();
  }
  assert.ok(
    events.some(
      event =>
        event.type === 'repository.tool_result' && (event.data as { tool: string }).tool === 'grampus_read_changes',
    ),
  );
});

function editingFixture(t: { after(fn: () => void): void }): EditingContext {
  const cwd = mkdtempSync(join(tmpdir(), 'grampus-codex-patch-'));
  writeFileSync(join(cwd, 'file.txt'), 'before\n');
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const artifact = `sha256:${'a'.repeat(64)}`;
  const instructionsDigest = 'b'.repeat(64);
  return {
    cwd,
    policy: { artifact, instructionsDigest, files: ['file.txt'] },
    snapshot: {
      artifact,
      instructionsDigest,
      head: 'fixture',
      index: '',
      diff: [],
      instructions: [],
      files: [{ path: 'file.txt', sha256: 'a'.repeat(64), executable: false }],
    },
  };
}

const proposed = {
  id: 'patch-1',
  type: 'fileChange',
  status: 'inProgress',
  changes: [{ path: 'file.txt', kind: { type: 'update', move_path: null }, diff: '-before\n+after' }],
};
const approval = { threadId: 'thread-1', turnId: 'turn-1', itemId: 'patch-1', grantRoot: null };

// Have the fake server assert the response it actually received on the wire.
async function approvalCase(
  editing: EditingContext | undefined,
  setup: string,
  params: unknown,
  expected: string,
  events: AgentEvent[] = [],
  onEvent = (_event: AgentEvent) => {},
) {
  const agent = fixture(
    `
    if (r.method === 'turn/start') {
      note('turn/started', { turn: { id: 'turn-1' } });
      ${setup}
      send({ id: 'approval-1', method: 'item/fileChange/requestApproval', params: ${JSON.stringify(params)} });
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
    }
    if (r.id === 'approval-1') {
      if ((r.result?.decision ?? (r.error ? 'error' : 'missing')) !== ${JSON.stringify(expected)}) process.exit(3);
      note('item/completed', { item: { type: 'agentMessage', text: JSON.stringify(reply) } });
      note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    }
  `,
    events,
    onEvent,
    editing,
  );
  try {
    assert.equal((await agent.turn('Edit the file')).status, 'completed');
  } finally {
    await agent.close();
  }
}

const startPatch = `note('item/started', { turnId: 'turn-1', item: ${JSON.stringify(proposed)} });`;

test('Codex approves only a current proposed patch and persists its authorization first', async t => {
  const context = editingFixture(t);
  const events: AgentEvent[] = [];
  await approvalCase(context, startPatch, approval, 'accept', events);
  assert.deepEqual(events.find(event => event.type === 'tool.authorized')?.data, {
    tool: 'apply_patch',
    paths: ['file.txt'],
  });
  await approvalCase(undefined, startPatch, approval, 'error');
  await approvalCase(context, startPatch, approval, 'decline', [], event => {
    if (event.type === 'tool.authorized') throw new Error('Journal unavailable');
  });
});

test('Codex grants a single scoped add approval and rejects mixed unauthorized additions', async t => {
  const context = editingFixture(t);
  context.policy.create = ['new.txt'];
  execFileSync('git', ['init', context.cwd], { windowsHide: true, stdio: 'pipe' });
  const item = {
    ...proposed,
    changes: [...proposed.changes, { path: 'new.txt', kind: { type: 'add' }, diff: '+created\n' }],
  };
  const setup = `note('item/started', { turnId: 'turn-1', item: ${JSON.stringify(item)} });`;
  const events: AgentEvent[] = [];
  await approvalCase(context, setup, approval, 'accept', events);
  assert.deepEqual(events.find(event => event.type === 'tool.authorized')?.data, {
    tool: 'apply_patch',
    paths: ['file.txt', 'new.txt'],
  });
  await approvalCase(context, setup, approval, 'decline', [], event => {
    if (event.type === 'tool.authorized') throw new Error('Journal unavailable');
  });
  const foreign = {
    ...item,
    changes: [...item.changes, { path: 'outside.txt', kind: { type: 'add' }, diff: '+outside' }],
  };
  await approvalCase(
    context,
    `note('item/started', { turnId: 'turn-1', item: ${JSON.stringify(foreign)} });`,
    approval,
    'decline',
  );
});

test('Codex approves only explicitly authorized unchanged deletions through the item approval protocol', async t => {
  const context = editingFixture(t);
  context.policy.files = [];
  context.policy.delete = ['file.txt'];
  context.snapshot.files[0]!.sha256 = createHash('sha256').update('before\n').digest('hex');
  const item = { ...proposed, changes: [{ path: 'file.txt', kind: { type: 'delete' }, diff: '-before\n' }] };
  const setup = `note('item/started', { turnId: 'turn-1', item: ${JSON.stringify(item)} });`;
  const events: AgentEvent[] = [];
  await approvalCase(context, setup, approval, 'accept', events);
  assert.deepEqual(events.find(event => event.type === 'tool.authorized')?.data, {
    tool: 'apply_patch',
    paths: ['file.txt'],
  });
  await approvalCase(context, setup, approval, 'decline', [], event => {
    if (event.type === 'tool.authorized') throw new Error('Journal unavailable');
  });
  writeFileSync(join(context.cwd, 'file.txt'), 'changed after snapshot');
  await approvalCase(context, setup, approval, 'decline');
});

test('Codex rejects missing, foreign, completed, duplicate and broader patch approvals', async t => {
  const context = editingFixture(t);
  for (const params of [
    { ...approval, threadId: 'foreign' },
    { ...approval, turnId: 'stale' },
    { ...approval, itemId: 'unknown' },
    { ...approval, grantRoot: context.cwd },
    { ...approval, permissions: {} },
  ]) {
    await approvalCase(context, startPatch, params, 'decline');
  }
  await approvalCase(context, '', approval, 'decline');
  await approvalCase(context, startPatch + startPatch, approval, 'decline');
  await approvalCase(
    context,
    startPatch + `note('item/completed', { turnId: 'turn-1', item: ${JSON.stringify(proposed)} });`,
    approval,
    'decline',
  );
  await approvalCase(
    context,
    startPatch +
      `note('item/fileChange/patchUpdated', { turnId: 'turn-1', itemId: 'patch-1', changes: [{path:'outside.txt',kind:{type:'add'},diff:'new'}] });`,
    approval,
    'decline',
  );
});

test('Codex never reuses a patch grant, and command or unknown permission requests stay denied', async t => {
  const agent = fixture(
    `
    if (r.method === 'turn/start') {
      note('turn/started', { turn: { id: 'turn-1' } }); ${startPatch}
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
      send({ id: 'first', method: 'item/fileChange/requestApproval', params: ${JSON.stringify(approval)} });
    }
    if (r.id === 'first') {
      if (r.result?.decision !== 'accept') process.exit(3);
      send({ id: 'second', method: 'item/fileChange/requestApproval', params: ${JSON.stringify(approval)} });
    }
    if (r.id === 'second') {
      if (r.result?.decision !== 'decline') process.exit(4);
      send({ id: 'command', method: 'item/commandExecution/requestApproval', params: ${JSON.stringify(approval)} });
    }
    if (r.id === 'command') {
      if (r.result?.decision !== 'decline') process.exit(5);
      send({ id: 'permissions', method: 'item/permissions/requestApproval', params: ${JSON.stringify(approval)} });
    }
    if (r.id === 'permissions') {
      if (!r.error) process.exit(6);
      note('item/completed', { item: { type: 'agentMessage', text: JSON.stringify(reply) } });
      note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
    }
  `,
    [],
    undefined,
    editingFixture(t),
  );
  try {
    assert.equal((await agent.turn('Edit')).status, 'completed');
  } finally {
    await agent.close();
  }
});

test('Codex handles notifications arriving before turn/start acknowledgement and ignores other threads', async () => {
  const events: AgentEvent[] = [];
  const agent = fixture(
    `
    if (r.method === 'turn/start') {
      note('turn/started', { turn: { id: 'turn-1' } });
      note('item/completed', { threadId: 'other', item: { type: 'agentMessage', text: 'invalid' } });
      note('item/completed', { turnId: 'turn-1', item: { type: 'agentMessage', text: JSON.stringify(reply) } });
      note('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { total: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 50 } } });
      note('thread/tokenUsage/updated', { turnId: 'turn-1', tokenUsage: { total: { inputTokens: 150, outputTokens: 30, cachedInputTokens: 70 } } });
      note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
    }
  `,
    events,
  );
  try {
    const output = await agent.turn('Hello');
    assert.deepEqual(output.reply, reply);
    assert.equal(output.usage?.inputTokens, 150);
    assert.equal(output.usage?.billedCostUsd, null);
    assert.ok(events.some(e => e.type === 'turn.started'));
  } finally {
    await agent.close();
  }
});

test('Codex interruption requires a terminal notification, not just the RPC receipt', async () => {
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => {
    notifyStarted = resolve;
  });
  const agent = fixture(
    `
    if (r.method === 'turn/start') {
      note('turn/started', { turn: { id: 'turn-1' } });
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
    }
    if (r.method === 'turn/interrupt') {
      send({ id: r.id, result: {} });
      setTimeout(() => note('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } }), 50);
    }
  `,
    [],
    event => {
      if (event.type === 'turn.started') notifyStarted();
    },
  );
  try {
    const output = agent.turn('Long task');
    await started;
    let finished = false;
    void output.then(() => {
      finished = true;
    });
    await agent.interrupt();
    assert.equal(finished, false);
    assert.equal((await output).status, 'interrupted');
  } finally {
    await agent.close();
  }
});

test('Codex stops granting patches as soon as interruption is requested', async t => {
  let notifyStarted!: () => void;
  const started = new Promise<void>(resolve => {
    notifyStarted = resolve;
  });
  const agent = fixture(
    `
    if (r.method === 'turn/start') {
      note('turn/started', { turn: { id: 'turn-1' } }); ${startPatch}
      send({ id: r.id, result: { turn: { id: 'turn-1' } } });
    }
    if (r.method === 'turn/interrupt') {
      send({ id: 'late-approval', method: 'item/fileChange/requestApproval', params: ${JSON.stringify(approval)} });
      send({ id: r.id, result: {} });
    }
    if (r.id === 'late-approval') {
      if (r.result?.decision !== 'decline') process.exit(3);
      note('turn/completed', { turn: { id: 'turn-1', status: 'interrupted' } });
    }
  `,
    [],
    event => {
      if (event.type === 'turn.started') notifyStarted();
    },
    editingFixture(t),
  );
  try {
    const result = agent.turn('Edit');
    await started;
    await agent.interrupt();
    assert.equal((await result).status, 'interrupted');
  } finally {
    await agent.close();
  }
});

test('Codex process death cannot be mistaken for successful completion', async () => {
  const agent = fixture(
    `if (r.method === 'turn/start') { send({ id: r.id, result: { turn: { id: 'turn-1' } } }); process.exit(2); }`,
  );
  try {
    await assert.rejects(agent.turn('Hello'), /exited/);
  } finally {
    await agent.close();
  }
});

test('Codex malformed output and provider failures are not accepted as successful replies', async () => {
  const malformed = fixture(`if (r.method === 'turn/start') {
    send({ id: r.id, result: { turn: { id: 'turn-1' } } });
    note('item/completed', { item: { type: 'agentMessage', text: 'not JSON' } });
    note('turn/completed', { turn: { id: 'turn-1', status: 'completed' } });
  }`);
  try {
    await assert.rejects(malformed.turn('Hello'));
  } finally {
    await malformed.close();
  }
  const failed = fixture(`if (r.method === 'turn/start') {
    send({ id: r.id, result: { turn: { id: 'turn-1' } } });
    note('turn/completed', { turn: { id: 'turn-1', status: 'failed', error: { message: 'Provider unavailable' } } });
  }`);
  try {
    const output = await failed.turn('Hello');
    assert.equal(output.status, 'failed');
    assert.equal(output.error, 'Provider unavailable');
    assert.equal(output.reply, null);
  } finally {
    await failed.close();
  }
});
