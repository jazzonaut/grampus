// Prepare each fresh worktree before specs or baseline checks. Setup has its own immutable evidence.
import { z } from 'zod';
import { runChecks } from '../checks/run-checks.js';
import { checkDefinitionSchema } from '../domain/spec.js';
import { git, headSha, uncommittedPaths } from '../git/git.js';
import type { DriverCore } from './driver-core.js';
import { DriverStop } from './driver-core.js';

const configuration = z.object({ setup: checkDefinitionSchema.nullable() }).strict();

/** Snapshot explicit setup from the base commit, with lockfile-based Node defaults when absent. */
async function configure(core: DriverCore, cwd: string): Promise<void> {
  if (core.state.setup.configuration) return;
  const sha = core.state.workspace?.baseSha;
  if (!sha) throw new DriverStop('Setup needs a recorded base commit.');
  const files = (await git(cwd, ['ls-tree', '--name-only', sha])).split(/\r?\n/);
  let command = null;
  let source = 'no repository setup';
  if (files.includes('grampus.json')) {
    command = configuration.parse(JSON.parse(await git(cwd, ['show', `${sha}:grampus.json`]))).setup;
    source = 'grampus.json at the base commit';
  } else {
    const install = files.includes('pnpm-lock.yaml')
      ? 'pnpm install --frozen-lockfile'
      : files.includes('package-lock.json')
        ? 'npm ci'
        : null;
    if (install) {
      command = { name: 'Install dependencies', command: install };
      source = 'root lockfile at the base commit';
    }
  }
  core.record({ type: 'setup.configured', sha, command, source });
}

/** Run setup once successfully. An interrupted attempt requires an explicit retry, never a silent replay. */
export async function prepareWorkspace(core: DriverCore, cwd: string): Promise<void> {
  await configure(core, cwd);
  const configured = core.state.setup.configuration;
  if (!configured?.command) return;
  for (let attempt = 1; ; attempt++) {
    const recorded = core.state.setup.results.find(item => item.attempt === attempt);
    if (recorded?.result.passed && !recorded.problems.length) return;
    if (core.state.setup.attempts >= attempt) {
      await core.decide(
        `setup-failed:${attempt}`,
        recorded
          ? `Repository setup failed: ${recorded.problems.join('; ') || `see ${recorded.result.logPath}`}. Fix the environment, then retry setup.`
          : 'Repository setup was interrupted; its outcome is unknown. Ensure its previous process has stopped before retrying.',
        ['retry', 'abandon'],
      );
      continue;
    }
    if ((await headSha(cwd)) !== configured.sha || (await uncommittedPaths(cwd)).length)
      throw new DriverStop('Setup requires the clean recorded base commit.');
    core.record({ type: 'setup.started', attempt });
    const result = await runSetup(core, cwd, configured.command, attempt);
    if (!result) throw new DriverStop('Setup produced no result.');
    const problems = (await uncommittedPaths(cwd)).map(file => `setup left an uncommitted file: ${file}`);
    if ((await headSha(cwd)) !== configured.sha) problems.push('setup moved HEAD');
    core.record({ type: 'setup.recorded', attempt, sha: configured.sha, result, problems });
    if (result.passed && !problems.length) return;
    await core.decide(
      `setup-failed:${attempt}`,
      `Repository setup failed. ${problems.join('; ')} Log: ${result.logPath}. Fix the environment, then retry setup.`,
      ['retry', 'abandon'],
    );
  }
}

async function runSetup(
  core: DriverCore,
  cwd: string,
  command: z.infer<typeof checkDefinitionSchema>,
  attempt: number,
) {
  const controller = new AbortController();
  let done = false;
  const work = runChecks(cwd, [command], core.store.checksDir('setup', attempt), {
    rerunFailures: false,
    signal: controller.signal,
  }).finally(() => {
    done = true;
  });
  try {
    while (!done) await core.pump();
    return (await work)[0];
  } finally {
    controller.abort();
    await work;
  }
}
