// Pins implementation observations as data, never an independent review verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseReply } from '../src/providers/types.js';

test('an implementation message may report concrete findings without becoming a review', () => {
  const findings = [
    { severity: 'blocking', description: 'A dependency is unavailable', evidence: 'The check exited 1' },
  ];
  const reply = parseReply({
    kind: 'message',
    text: 'Implementation completed with observations',
    questions: [],
    findings,
  });
  assert.equal(reply.kind, 'message');
  assert.deepEqual(reply.findings, findings);
  assert.throws(
    () => parseReply({ ...reply, lenses: [{ lens: 'simplification', verdict: 'pass', summary: 'OK', findings: [] }] }),
    /Only a review/,
  );
  assert.throws(
    () => parseReply({ ...reply, priorFindings: [{ id: 'x', status: 'resolved', evidence: 'OK' }] }),
    /Only a review/,
  );
});
