// Prepare each fresh worktree before specs or baseline checks. Setup has its own immutable evidence.
import { runChecks } from '../checks/run-checks.js';
import type { CheckDefinition } from '../domain/spec.js';
import { headSha, uncommittedPaths } from '../git/git.js';
import type { DriverCore } from './driver-core.js';
import { DriverStop } from './driver-core.js';

import { repositoryConfiguration } from './repository-config.js';
import { prepareCheckout } from '../git/checkout.js';

/** Snapshot explicit setup from the base commit, with lockfile-based Node defaults when absent. */
async function configure(core: DriverCore, cwd: string): Promise<void> {
  if (core.state.setup.configuration) return;
  const sha = core.state.workspace?.baseSha;
  if (!sha) throw new DriverStop('Setup needs a recorded base commit.');
  if ((await headSha(cwd)) !== sha) throw new DriverStop('Setup requires the recorded base commit.');
  await prepareCheckout(cwd);
  core.record({ type: 'setup.configured', sha, ...(await repositoryConfiguration(cwd, sha)) });
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

async function runSetup(core: DriverCore, cwd: string, command: CheckDefinition, attempt: number) {
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
