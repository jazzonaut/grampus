// Pins inference-free catalogue controls, bounded pagination and independent provider failures.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { providerLimits } from '../src/config/limits.js';
import { discoverProviderModels, readClaudeModels, readCodexModels } from '../src/providers/model-catalogue.js';

test('Codex model discovery follows cursors and returns wire model IDs and supported efforts', async () => {
  const requests: { method: string; params: unknown }[] = [];
  const models = await readCodexModels({
    request: async (method, params) => {
      requests.push({ method, params });
      return {
        data: [
          {
            id: 'picker-row',
            model: `wire-model-${requests.length}`,
            displayName: 'Model',
            hidden: false,
            supportedReasoningEfforts: [
              { reasoningEffort: 'high', description: 'Thorough' },
              { reasoningEffort: 'future-effort' },
            ],
          },
          {
            id: 'hidden',
            model: 'hidden',
            displayName: 'Hidden',
            hidden: true,
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: requests.length === 1 ? 'next' : null,
      };
    },
  });
  assert.deepEqual(
    models.map(model => model.id),
    ['wire-model-1', 'wire-model-2'],
  );
  assert.deepEqual(models[0]?.efforts, ['high']);
  assert.deepEqual(
    requests,
    [null, 'next'].map(cursor => ({
      method: 'model/list',
      params: { cursor, limit: providerLimits.modelListPage, includeHidden: false },
    })),
  );
});

test('empty pages with a continuing cursor cannot loop forever or return partial success', async () => {
  let calls = 0;
  await assert.rejects(
    readCodexModels({
      request: async () => {
        calls++;
        return { data: [], nextCursor: 'again' };
      },
    }),
    /pagination/,
  );
  assert.equal(calls, providerLimits.modelListPages);
});

test('Claude suggestions retain provider aliases and distinguish unsupported from unknown efforts', async () => {
  const models = await readClaudeModels({
    supportedModels: async () => [
      { value: 'sonnet', resolvedModel: 'canonical', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] },
      { value: 'fast', displayName: 'Fast', supportsEffort: false },
      { value: 'custom', displayName: 'Custom' },
    ],
  });
  assert.deepEqual(models, [
    { id: 'sonnet', label: 'Sonnet', efforts: ['low', 'high'] },
    { id: 'fast', label: 'Fast', efforts: [] },
    { id: 'custom', label: 'Custom', efforts: null },
  ]);
  await assert.rejects(readClaudeModels({ supportedModels: async () => [{ value: 5 }] }));
});

test('one unavailable or malformed catalogue leaves the other usable without leaking provider errors', async () => {
  const result = await discoverProviderModels({
    codex: async () => {
      throw new Error('SECRET provider detail');
    },
    claude: () => readClaudeModels({ supportedModels: async () => [{ value: 'sonnet', displayName: 'Sonnet' }] }),
  });
  assert.equal(result.codex.models.length, 0);
  assert.match(result.codex.problem ?? '', /manually/);
  assert.equal(result.claude.models[0]?.id, 'sonnet');
  assert.equal(result.claude.problem, null);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});
