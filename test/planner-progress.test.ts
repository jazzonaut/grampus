import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/persistence/store.js';
import { Sessions } from '../src/execution/sessions.js';
import { agentProgress, plannerProgress } from '../src/orchestration/planner-progress.js';

test('planner progress follows owned events, stays compact and never returns raw replies or tool results', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sessions = new Sessions(store),
    session = sessions.create('claude', process.cwd());
  const claim = sessions.claim(session.id, 'SECRET CONTROLLER PROMPT');
  const emit = (type: string, data: unknown) => sessions.event(session.id, claim.runId, { type, data });
  const progress = () => plannerProgress(store.sessionEvents(session.id), sessions.get(session.id))!;
  assert.equal(progress().stage, 'connecting');
  emit('session.connected', { providerSessionId: 'offline-planner', model: null });
  emit('turn.started', {});
  assert.equal(progress().stage, 'working');
  emit('repository.tool_requested', { tool: 'grampus_search', arguments: { query: 'ExportService' } });
  assert.match(progress().activity, /Searching repository for “ExportService”/);
  emit('repository.tool_result', { tool: 'grampus_search', result: { matches: [{ text: 'SECRET FILE CONTENT' }] } });
  emit('repository.tool_requested', {
    tool: 'grampus_read_file',
    root: 'reference-1',
    arguments: { path: 'src/export.ts' },
  });
  assert.equal(progress().activity, 'Reading reference-1/src/export.ts');
  emit('repository.tool_result', {
    tool: 'grampus_read_file',
    root: 'reference-1',
    result: { path: 'src/export.ts', lines: ['SECRET FILE CONTENT'] },
  });
  // C0, DEL and C1 control characters in agent-chosen arguments are blanked before display.
  emit('repository.tool_requested', {
    tool: 'grampus_read_file',
    arguments: { path: 'a\u0007b\u007fc\u0080d\u009be\u009ff g' },
  });
  assert.equal(progress().activity, 'Reading a b c d e f g');
  emit('integration.tool_authorized', { tool: 'mcp__linear__get_issue' });
  assert.equal(progress().repositoryCalls, 2);
  assert.equal(progress().integrationCalls, 1);
  assert.ok(progress().recent.some(item => item.label === 'Read reference-1/src/export.ts'));
  assert.ok(progress().recent.some(item => item.label === 'Requested linear · get_issue'));
  emit('output.delta', { text: '{"private":"SECRET PARTIAL RESPONSE' });
  assert.equal(progress().stage, 'responding');
  assert.doesNotMatch(JSON.stringify(progress()), /SECRET/);
  for (let i = 0; i < 8; i++) emit('integration.tool_authorized', { tool: `mcp__linear__read_${i}` });
  assert.equal(progress().recent.length, 4);
  assert.equal(progress().integrationCalls, 9);
  sessions.stop(session.id, claim.runId, 'User stopped planning');
  assert.equal(progress().stage, 'stopping');
  sessions.settle(session.id, claim.runId, { status: 'interrupted', reply: null, usage: null, error: null }, true);
  assert.equal(plannerProgress(store.sessionEvents(session.id), sessions.get(session.id)), null);
  const next = sessions.claim(session.id, 'Continue');
  const fresh = progress();
  assert.equal(fresh.runId, next.runId);
  assert.equal(fresh.repositoryCalls, 0);
  assert.equal(fresh.integrationCalls, 0);
  assert.deepEqual(fresh.recent, []);
  assert.equal(fresh.stage, 'connecting');
  // Late events from the old turn cannot become visible activity in this turn.
  assert.equal(emit('output.delta', { text: 'Old turn' }), false);
  assert.equal(progress().stage, 'connecting');
});

test('execution activity reports file requests without claiming completed edits or exposing their contents', t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const sessions = new Sessions(store),
    session = sessions.create('codex', process.cwd());
  const claim = sessions.claim(session.id, 'PRIVATE PROMPT');
  const emit = (type: string, data: unknown) => sessions.event(session.id, claim.runId, { type, data });
  const progress = () => agentProgress(store.sessionEvents(session.id), sessions.get(session.id), 'implementation')!;
  emit('tool.authorized', { tool: 'Read', path: 'src/context.ts', content: 'PRIVATE CONTENT' });
  assert.equal(progress().fileRequests, 0);
  emit('tool.authorized', { tool: 'apply_patch', paths: ['src/change.ts'], patch: 'PRIVATE PATCH' });
  assert.equal(progress().activity, 'Requested file changes: src/change.ts');
  assert.equal(progress().fileRequests, 1);
  emit('tool.authorized', { tool: 'Write', path: 'src/new.ts', content: 'PRIVATE CONTENT' });
  emit('tool.authorized', { tool: 'mcp__grampus_files__delete_file', path: 'src/old.ts' });
  emit('tool.deleted', { path: 'src/old.ts' });
  assert.equal(progress().fileRequests, 3);
  assert.equal(progress().activity, 'Deleted src/old.ts');
  emit('output.delta', { text: 'PRIVATE RESPONSE' });
  assert.equal(progress().activity, 'Writing the implementation response');
  assert.equal(
    agentProgress(store.sessionEvents(session.id), sessions.get(session.id), 'review')!.activity,
    'Writing the review response',
  );
  assert.doesNotMatch(JSON.stringify(progress()), /PRIVATE/);
});
