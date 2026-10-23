// Disposable Git copies let reviewers reproduce boundary failures without altering the candidate.
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { git, headSha } from '../git/git.js';
import { runChecks } from '../checks/run-checks.js';
import { currentSettings } from '../config/settings.js';
import { matchesAny } from '../util/glob.js';
import type { ReviewReport } from '../domain/review.js';
import type { DriverCore } from './driver-core.js';
import type { SpecVersion } from './state.js';
import { approvedSpecPath, excludeWorkerFolder } from './workspace-files.js';
import { checkDeadline, deliverySignal } from './delivery.js';

/** Reuse only this exact candidate's copy; dependency setup is recorded before any worker uses it. */
export async function reviewWorkspace(
  core: DriverCore,
  source: string,
  sha: string,
  spec: SpecVersion,
): Promise<string> {
  if (!core.state.recipe.delivery) return source;
  const path = join(core.store.dir, 'review-workspaces', `${spec.version}-${sha}`);
  const recorded = core.events.find(
    event => event.type === 'review.workspace' && event.sha === sha && event.specVersion === spec.version,
  );
  if (recorded?.type === 'review.workspace') {
    if ((await headSha(path)) !== sha) throw new Error('The isolated review checkout moved.');
    if (recorded.results.some(result => !result.passed))
      throw new Error('Isolated review setup failed; its recorded result remains unsuccessful.');
    return path;
  }
  if (
    core.events.some(
      event => event.type === 'review.preparing' && event.sha === sha && event.specVersion === spec.version,
    )
  )
    throw new Error(
      'Isolated review setup was interrupted. Its outcome is unknown and will not be replayed automatically.',
    );
  checkDeadline(core);
  mkdirSync(path, { recursive: true });
  if (!existsSync(join(path, '.git'))) await git(path, ['init', '-q']);
  await git(path, ['fetch', '--quiet', '--depth=1', '--no-tags', source, sha, core.state.workspace?.baseSha ?? sha]);
  await git(path, ['checkout', '--quiet', '--detach', sha]);
  await excludeWorkerFolder(path);
  writeFileSync(approvedSpecPath(path), readFileSync(spec.path));
  const setup = core.state.setup.configuration?.command;
  core.record({ type: 'review.preparing', sha, specVersion: spec.version, path });
  const results = setup
    ? await runChecks(path, [setup], core.store.checksDir(`review-setup-${sha}`, spec.version), {
        rerunFailures: false,
        signal: deliverySignal(core),
      })
    : [];
  core.record({ type: 'review.workspace', sha, specVersion: spec.version, path, results });
  checkDeadline(core);
  if (results.some(result => !result.passed))
    throw new Error(`Isolated review setup failed: ${results.map(result => result.logPath).join(', ')}`);
  if ((await headSha(path)) !== sha) throw new Error('Review setup changed the candidate commit.');
  return path;
}

/** Execute reviewer-authored probes independently; retained source and logs make claims inspectable. */
export async function executeReviewProbes(
  core: DriverCore,
  cwd: string,
  binding: { sha: string; specVersion: number; round: number; attempt: number },
  report: ReviewReport,
): Promise<void> {
  const { sha, specVersion, round, attempt } = binding;
  if (!core.state.recipe.delivery) return;
  if ((await headSha(cwd)) !== sha || (await git(cwd, ['diff', '--name-only', sha])).trim())
    throw new Error('The reviewer changed tracked files or the commit in its isolated checkout.');
  for (const [index, probe] of (report.probes ?? []).entries()) {
    const key = `probe:${round}:${attempt}:${index}`;
    if (core.events.some(event => event.type === 'review.probe' && event.key === key)) continue;
    const target = resolve(cwd, probe.suggestedPath);
    const local = relative(cwd, target);
    if (
      isAbsolute(local) ||
      local.startsWith('..') ||
      !matchesAny(local.replaceAll('\\', '/'), currentSettings().testFilePatterns)
    )
      throw new Error(`Probe path must be a test inside the isolated checkout: ${probe.suggestedPath}`);
    for (let part = target; part !== resolve(cwd); part = dirname(part))
      if (existsSync(part) && lstatSync(part).isSymbolicLink())
        throw new Error('Review probe paths cannot traverse symbolic links.');
    // Existing committed regressions are exercised by the declared command, never overwritten by a probe.
    if (!probe.regressionTest) {
      const tracked = await git(cwd, ['ls-files', '--', local]);
      if (tracked.trim()) throw new Error(`A new review probe cannot overwrite a tracked test: ${local}`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, probe.source);
    }
    const [result] = await runChecks(
      cwd,
      [{ name: key, command: probe.command }],
      core.store.checksDir('review-probes', round),
      { rerunFailures: false, signal: deliverySignal(core) },
    );
    checkDeadline(core);
    if (!result) throw new Error('Review probe did not run.');
    core.record({
      type: 'review.probe',
      key,
      sha,
      specVersion,
      scenario: probe.scenario,
      source: probe.source,
      result,
    });
    if (!result.passed && probe.regressionTest)
      throw new Error(`Claimed committed regression failed: ${probe.scenario}; ${result.logPath}`);
  }
}
