import { describe, expect, it } from 'vitest';
import { mockAnswerAction, mockAssessAction, mockReviseAction } from '../mock';
import { buildRequest, initialDrafts, pointerSegments, writeAt, type FormDrafts } from './actions';

describe('JSON pointers', () => {
  it('decodes ~1 and ~0 as RFC 6901 says', () => {
    expect(pointerSegments('/answers/a~1b/c~0d')).toEqual(['answers', 'a/b', 'c~d']);
  });

  it('creates missing objects and removes a property for undefined', () => {
    const body = { expected: 'k', plan: { reviewPolicy: { arbitrator: { provider: 'codex' }, repairRounds: 1 } } };
    writeAt(body, '/answers/x', 'yes');
    writeAt(body, '/plan/reviewPolicy/arbitrator', undefined);
    expect(body).toEqual({ expected: 'k', answers: { x: 'yes' }, plan: { reviewPolicy: { repairRounds: 1 } } });
  });
});

describe('buildRequest', () => {
  it('writes answers at their question ids and keeps the decision key', () => {
    const drafts: FormDrafts = {
      'answer-0': { kind: 'text', text: 'Yes, permanently' },
      'answer-1': { kind: 'text', text: 'Keep it' },
    };
    expect(buildRequest(mockAnswerAction, drafts)).toEqual({
      ok: true,
      method: 'POST',
      path: '/api/tasks/task-1/answer',
      body: { expected: 'decision-7', answers: { redirect: 'Yes, permanently', 'a/b': 'Keep it' } },
    });
  });

  it('refuses empty required answers and sends nothing', () => {
    const built = buildRequest(mockAnswerAction, initialDrafts(mockAnswerAction.form));
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.issues.map(issue => issue.field)).toEqual(['answer-0', 'answer-1']);
  });

  it('requires an assessment outcome to be chosen, then sends outcome and summary', () => {
    const drafts = initialDrafts(mockAssessAction.form);
    expect(drafts['outcome']).toEqual({ kind: 'choice', index: null });
    expect(buildRequest(mockAssessAction, { ...drafts, summary: { kind: 'text', text: 'Fine' } }).ok).toBe(false);
    expect(
      buildRequest(mockAssessAction, {
        outcome: { kind: 'choice', index: 1 },
        summary: { kind: 'text', text: 'Too clever' },
      }),
    ).toMatchObject({ ok: true, body: { expected: 'decision-7', outcome: 'failed', summary: 'Too clever' } });
  });

  it('assembles a revision: the JSON plan first, then each field over it at its pointer', () => {
    const drafts = initialDrafts(mockReviseAction.form);
    drafts['title'] = { kind: 'text', text: 'Renamed' };
    drafts['validation-repairs'] = { kind: 'text', text: '4' };
    drafts['arbitrator'] = { kind: 'choice', index: 0 };
    drafts['quality-passes'] = { kind: 'choices', indices: [2, 0] };
    drafts['references'] = { kind: 'text', text: ' one \n\n two ' };
    const built = buildRequest(mockReviseAction, drafts);
    expect(built).toEqual({
      ok: true,
      method: 'POST',
      path: '/api/tasks/task-1/revise',
      body: {
        expected: 'decision-7',
        plan: {
          brief: { title: 'Renamed', outcome: 'Old outcome', plan: 'Old plan' },
          workflowPolicy: { mode: 'automatic', repairRounds: 4 },
          // "Stop for your decision" (a null option) removes the arbitrator.
          reviewPolicy: { repairRounds: 1 },
          quality: { passes: ['refactor', { id: 'simplification', kind: 'lens' }] },
          notes: ['one', 'two'],
        },
      },
    });
  });

  it('starts drafts from the current values and checks number bounds and JSON', () => {
    const drafts = initialDrafts(mockReviseAction.form);
    expect(drafts['arbitrator']).toEqual({ kind: 'choice', index: 1 });
    expect(drafts['quality-passes']).toEqual({ kind: 'choices', indices: [0] });
    expect(
      buildRequest(mockReviseAction, { ...drafts, 'validation-repairs': { kind: 'text', text: '9' } }),
    ).toMatchObject({
      ok: false,
      issues: [{ field: 'validation-repairs', message: 'Enter 5 or less.' }],
    });
    const invalid = buildRequest(mockReviseAction, { ...drafts, plan: { kind: 'text', text: '{ nope' } });
    expect(invalid.ok).toBe(false);
  });

  it('never changes the ActionView it was given', () => {
    const before = JSON.stringify(mockReviseAction);
    buildRequest(mockReviseAction, { title: { kind: 'text', text: 'Changed' } });
    expect(JSON.stringify(mockReviseAction)).toBe(before);
  });
});
