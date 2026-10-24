// Real package imports expose Windows resolver failures hidden by successful dependency installation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { recipeSchema } from '../src/domain/recipe.js';
import { parseSpec } from '../src/domain/spec.js';
import { headSha } from '../src/git/git.js';
import { DriverCore } from '../src/pipeline/driver-core.js';
import { reviewWorkspace } from '../src/pipeline/review-workspace.js';
import { TaskStore } from '../src/store/task-store.js';
import { pipelineRecipe } from './helpers/recipe-fixture.js';
import { createHarness, goodWorkers, specText, useTestSettings, worktreeOf } from './helpers/task-fixture.js';

test('review copies from a deeply nested task store can execute dependency package imports', async () => {
  const h = await createHarness(
    h => goodWorkers(h),
    recipeSchema.parse({ ...pipelineRecipe, delivery: { mode: 'unattended' } }),
  );
  const store = TaskStore.create(join(h.dataDir, 'benchmark-history-with-a-deliberately-long-label'), h.taskId);
  copyFileSync(h.store.eventsPath, store.eventsPath);
  const path = join(store.dir, 'spec.md');
  writeFileSync(path, specText());
  const parsed = parseSpec(specText());
  const spec = { ...parsed.block, path, hash: parsed.hash, version: 1, key: 'spec:1', at: new Date().toISOString() };
  const source = worktreeOf(h);
  const sha = await headSha(source);
  const core = new DriverCore(store, h.orca, () => {});
  const workspace = await reviewWorkspace(core, source, sha, spec);
  const dependency = join(workspace, 'node_modules/.pnpm/fixture-with-peer-dependency-names/node_modules/pkg');
  mkdirSync(dependency, { recursive: true });
  writeFileSync(
    join(dependency, 'package.json'),
    JSON.stringify({ type: 'module', imports: { '#enabled': './enabled.js' } }),
  );
  writeFileSync(join(dependency, 'enabled.js'), 'export default true;');
  writeFileSync(join(dependency, 'index.js'), 'import enabled from "#enabled"; console.log(enabled);');
  const result = spawnSync(process.execPath, [join(dependency, 'index.js')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'true');
  assert.equal(await headSha(workspace), sha);
  useTestSettings({ reviewWorkspaceRoot: join(h.dataDir, 'another-root') });
  assert.equal(await reviewWorkspace(new DriverCore(store, h.orca, () => {}), source, sha, spec), workspace);
});
