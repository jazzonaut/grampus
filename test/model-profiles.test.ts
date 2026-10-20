// Exercises profile snapshotting and approval binding through the public settings and plan APIs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defaultSettings, parseSettings, useSettings } from '../src/config/settings.js';
import { guidedPlanDigest, normalizeGuidedPlan } from '../src/domain/guided-plan.js';
import { fixture } from './helpers/guided-tasks.js';

import { profile } from './helpers/model-profiles.js';

test('a saved profile is copied into approval, including repair, quality passes and effort', t => {
  const f = fixture(t);
  t.after(() => useSettings(defaultSettings()));
  useSettings(parseSettings({ modelProfiles: [profile] }, 'fixture'));
  const plan = normalizeGuidedPlan({ ...f.plan, modelProfile: 'balanced' });
  assert.deepEqual(plan.implementation, profile.implementation);
  assert.deepEqual(plan.review, profile.review);
  assert.deepEqual(plan.modelProfile, profile);
  const digest = guidedPlanDigest(plan);
  const changed = normalizeGuidedPlan({
    ...f.plan,
    modelProfile: { ...profile, repair: { ...profile.repair, effort: 'medium' } },
  });
  assert.notEqual(guidedPlanDigest(changed), digest);
  profile.name = 'Edited later';
  assert.equal(plan.modelProfile?.name, 'Balanced');
  profile.name = 'Balanced';
});

test('profiles refuse unsupported effort and editing assignments that defeat independent review', () => {
  assert.throws(() => parseSettings({ modelProfiles: [{ ...profile, repair: profile.review }] }, 'fixture'));
  assert.throws(() =>
    parseSettings(
      { modelProfiles: [{ ...profile, planning: { ...profile.planning, effort: 'unrecognised' } }] },
      'fixture',
    ),
  );
  assert.throws(() => parseSettings({ modelProfiles: [profile, profile] }, 'fixture'));
});

test('Codex advertised max effort is retained while Claude rejects Codex-only effort values', () => {
  const settings = parseSettings(
    { modelProfiles: [{ ...profile, implementation: { ...profile.implementation, effort: 'max' } }] },
    'fixture',
  );
  assert.equal(settings.modelProfiles[0]?.implementation.effort, 'max');
  assert.throws(() =>
    parseSettings({ modelProfiles: [{ ...profile, review: { ...profile.review, effort: 'minimal' } }] }, 'fixture'),
  );
});
