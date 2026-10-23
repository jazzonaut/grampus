// Summary views must keep unresolved work visible and preserve the evidence behind compact rows.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reactive, nextTick } from 'vue';
import { componentSetup } from './helpers/vue-setup.js';

test('review coverage puts gaps first and groups repeated caveats without losing affected outcomes', async t => {
  const report = {
    verdict: 'approve',
    summary: 'Tests pass but transport is not exercised.',
    findings: [],
    coverage: [
      { acceptanceId: 'resume', status: 'verified', evidence: 'Resume test', limitations: ['Transport is mocked.'] },
      {
        acceptanceId: 'disconnect',
        status: 'unverified',
        evidence: 'No real transport test',
        limitations: ['Transport is mocked.', 'Identity is untested.'],
      },
    ],
  };
  const component = await componentSetup('web/app/components/ReviewBrief.vue', { report });
  t.after(component.stop);
  assert.equal(component.state['coverage'][0].acceptanceId, 'disconnect');
  assert.deepEqual(component.state['caveats'], [
    { text: 'Transport is mocked.', ids: ['disconnect', 'resume'] },
    { text: 'Identity is untested.', ids: ['disconnect'] },
  ]);
  assert.equal(report.coverage[0]?.acceptanceId, 'resume', 'the recorded report is not reordered');
});

test('questions needing an answer precede closed and answered messages', async t => {
  const messages = [
    { messageId: 'answered', kind: 'question', answered: true, closed: false },
    { messageId: 'closed', kind: 'question', answered: false, closed: true },
    { messageId: 'pending', kind: 'question', answered: false, closed: false },
  ];
  const component = await componentSetup('web/app/components/MessagesTab.vue', { messages });
  t.after(component.stop);
  assert.equal(component.state['ordered'][0].messageId, 'pending');
  assert.equal(component.state['pending'](messages[1]), false);
  assert.equal(component.state['pending'](messages[2]), true);
});

test('milestones retain operational failures and all activity remains available', async t => {
  const items = [
    { type: 'stage.started', tone: 'info', title: 'Started' },
    { type: 'stage.start_failed', tone: 'error', title: 'Failed' },
    { type: 'orca.uncertain', tone: 'warning', title: 'Uncertain' },
    { type: 'spec.recorded', tone: 'success', title: 'Spec' },
  ];
  const component = await componentSetup('web/app/components/TimelineList.vue', { items });
  t.after(component.stop);
  assert.deepEqual(
    component.state['newestFirst'].map((item: { title: string }) => item.title),
    ['Spec', 'Uncertain', 'Failed'],
  );
  component.state['allActivity'] = true;
  assert.equal(component.state['newestFirst'].length, 4);
});

test('spec selection keeps exact requirements and resets full-text mode for a new version', async t => {
  const props = reactive({
    specs: [{ version: 1, approved: false, acceptance: [{ id: 'resume', scenario: 'Keep score exactly.' }] }],
  });
  const component = await componentSetup('web/app/components/SpecTab.vue', props);
  t.after(component.stop);
  component.state['fullSpec'] = true;
  props.specs.push({
    version: 2,
    approved: false,
    acceptance: [{ id: 'resume', scenario: 'Keep score and heading exactly.' }],
  });
  await nextTick();
  assert.equal(component.state['fullSpec'], false);
  assert.equal(component.state['spec'].acceptance[0].scenario, 'Keep score and heading exactly.');
});
