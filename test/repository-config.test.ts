// Repository gates are selected from committed configuration and survive a worker's narrower spec.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { repositoryConfiguration } from '../src/pipeline/repository-config.js';
import { withRepositoryChecks, parseSpec } from '../src/domain/spec.js';
import { headSha } from '../src/git/git.js';
import { commitAll, createRepository, specText, write } from './helpers/task-fixture.js';

test('verification inference uses the base commit, prefers verify, and honours the package manager', async () => {
  const repo = await createRepository();
  write(
    repo,
    'package.json',
    JSON.stringify({ packageManager: 'pnpm@10.6.5', scripts: { verify: 'node verify.js', check: 'node check.js' } }),
  );
  await commitAll(repo, 'Declare project verification');
  const sha = await headSha(repo);
  write(repo, 'package.json', JSON.stringify({ scripts: { test: 'node test.js' } }));
  const configured = await repositoryConfiguration(repo, sha);
  assert.deepEqual(configured.verification.checks, [{ name: 'Repository verification', command: 'pnpm run verify' }]);
});

test('explicit repository checks support non-Node projects and do not repeat setup', async () => {
  const repo = await createRepository();
  const checks = [{ name: 'CI', command: 'dotnet test', timeoutSeconds: 300 }];
  write(repo, 'grampus.json', JSON.stringify({ setup: null, checks }));
  write(repo, 'package-lock.json', '{}');
  await commitAll(repo, 'Configure explicit checks');
  const configured = await repositoryConfiguration(repo, await headSha(repo));
  assert.equal(configured.command, null);
  assert.deepEqual(configured.verification.checks, checks);
  assert.match(configured.verification.source, /grampus.json/);
});

test('check is the fallback script and missing gates stay explicitly unknown', async () => {
  const repo = await createRepository();
  assert.deepEqual((await repositoryConfiguration(repo, await headSha(repo))).verification.checks, []);
  write(repo, 'package.json', JSON.stringify({ scripts: { check: 'node check.js' } }));
  write(repo, 'pnpm-lock.yaml', 'lockfileVersion: 9');
  await commitAll(repo, 'Configure check script');
  const configured = await repositoryConfiguration(repo, await headSha(repo));
  assert.equal(configured.verification.checks[0]?.command, 'pnpm run check');
  assert.equal(configured.command?.command, 'pnpm install --frozen-lockfile');
});

test('the approved spec includes mandatory gates once, preserves acceptance references and binds their settings', () => {
  const required = [{ name: 'CI', command: 'npm run verify', timeoutSeconds: 300 }];
  const original = specText([
    { name: 'acceptance', command: 'node acceptance.js' },
    { name: 'all checks', command: 'npm run verify' },
  ]);
  const spec = withRepositoryChecks(original, required);
  assert.deepEqual(spec.block.checks, [
    { name: 'all checks', command: 'npm run verify', timeoutSeconds: 300 },
    { name: 'acceptance', command: 'node acceptance.js' },
  ]);
  assert.equal(spec.hash, parseSpec(spec.markdown).hash);
  assert.equal(withRepositoryChecks(spec.markdown, required).hash, spec.hash, 'normalisation is idempotent');
  assert.throws(
    () => withRepositoryChecks(specText([{ name: 'CI', command: 'node weaker.js' }]), required),
    /reserved/,
  );
  const omitted = withRepositoryChecks(specText(), required);
  assert.equal(omitted.block.checks[0]?.command, 'npm run verify');
});

test('explicit configuration rejects an empty verification baseline', async () => {
  const repo = await createRepository();
  write(repo, 'grampus.json', JSON.stringify({ checks: [] }));
  await commitAll(repo, 'Declare invalid checks');
  await assert.rejects(repositoryConfiguration(repo, await headSha(repo)));
});

test('common behavioural checks are fixed at the base and cannot be narrowed by a recipe', async () => {
  const repo = await createRepository();
  write(repo, 'test/behaviour.test.js', 'import "./greet.test.js";\n');
  write(
    repo,
    'grampus.json',
    JSON.stringify({
      behaviouralHarness: {
        contract: 'Call greet(name) and compare its returned string. No private state.',
        files: ['test/behaviour.test.js', 'test/greet.test.js'],
        checks: [{ name: 'Common behaviour', command: 'node test/behaviour.test.js' }],
      },
    }),
  );
  await commitAll(repo, 'Declare common behavioural harness');
  const configured = await repositoryConfiguration(repo, await headSha(repo));
  assert.deepEqual(configured.verification.checks, [
    { name: 'Common behaviour', command: 'node test/behaviour.test.js', portable: true },
  ]);
  const spec = withRepositoryChecks(specText(), configured.verification.checks, configured.verification.harness);
  assert.deepEqual(spec.block.protected, ['test/behaviour.test.js', 'test/greet.test.js']);
  assert.match(spec.block.behaviouralHarness?.contract ?? '', /No private state/);
  assert.equal(
    withRepositoryChecks(spec.markdown, configured.verification.checks, configured.verification.harness).hash,
    spec.hash,
  );
});
