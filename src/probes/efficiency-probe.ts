// Owns explicit, local three-arm execution comparisons in separate clones of one pinned commit.
// Every command has durable supervised logs; failed or uncertain work is retained, never retried.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { commandLimits, processLimits } from '../config/limits.js';
import { runCheckProcess } from '../process/check-process.js';

const command = z.strictObject({
  file: z.string().min(1),
  args: z.array(z.string()).refine(args => JSON.stringify(args).length <= commandLimits.argsCharacters),
  timeoutMs: z.number().int().min(commandLimits.minTimeoutMs).max(commandLimits.maxTimeoutMs),
});
const commands = z.array(command).max(processLimits.benchmarkCommands);
const manifestSchema = z.strictObject({
  repository: z.string(),
  base: z.string().min(1),
  repetitions: z.number().int().min(1).max(processLimits.benchmarkRepetitions),
  setup: commands,
  verify: commands.min(1),
  arms: z
    .array(
      z.strictObject({
        name: z.enum(['direct', 'direct_with_gates', 'grampus']),
        commands: commands.min(1),
        resultDirectory: z.string(),
      }),
    )
    .length(3)
    .refine(arms => new Set(arms.map(arm => arm.name)).size === 3),
});
type Manifest = z.infer<typeof manifestSchema>;
type Arm = Manifest['arms'][number];

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: processLimits.worktreeCreateTimeoutMs,
    maxBuffer: processLimits.commandOutputBytes,
  }).trim();
}

function substitute(value: string, paths: Record<'repo' | 'output' | 'result', string>): string {
  return value.replace(/\{(repo|output|result)\}/g, (_, name: 'repo' | 'output' | 'result') => paths[name]);
}

function persist(output: string, value: unknown): void {
  const path = join(output, 'result.json');
  writeFileSync(`${path}.tmp`, JSON.stringify(value, null, 2));
  renameSync(`${path}.tmp`, path);
}

async function runCommands(
  items: Manifest['setup'],
  cwd: string,
  paths: Record<'repo' | 'output' | 'result', string>,
  stage: string,
) {
  let elapsedMs = 0;
  for (const [index, item] of items.entries()) {
    const directory = mkdtempSync(join(paths.output, `${stage}-${index}-`));
    const spec = {
      file: item.file === 'node' ? process.execPath : substitute(item.file, paths),
      args: item.args.map(arg => substitute(arg, paths)),
      timeoutMs: item.timeoutMs,
    };
    if (!isAbsolute(spec.file)) throw new Error('Benchmark commands require node or an absolute executable');
    const receipt = { directory, token: randomUUID(), checkId: randomUUID() };
    const ledger = join(paths.output, 'commands.jsonl');
    appendFileSync(ledger, JSON.stringify({ stage, index, cwd, spec, receipt, dispatch: 'requested' }) + '\n');
    const started = performance.now();
    const result = await runCheckProcess({
      ...spec,
      cwd,
      receipt,
      started: (kind, pid) => appendFileSync(ledger, JSON.stringify({ stage, index, kind, pid }) + '\n'),
    });
    elapsedMs += performance.now() - started;
    appendFileSync(ledger, JSON.stringify({ stage, index, receipt, result }) + '\n');
    if (!result.exitConfirmed) throw new Error(`Uncertain ${stage} command; retain ${directory} and do not retry`);
    if (result.reason !== 'exited' || result.exitCode !== 0 || result.outputUnavailable || result.outputTruncated)
      return { passed: false, elapsedMs, stoppedAt: index, reason: result.reason, logs: directory };
  }
  return { passed: true, elapsedMs, stoppedAt: null, reason: null, logs: null };
}

async function runArm(manifest: Manifest, arm: Arm, root: string, base: string, repetition: number) {
  const output = join(root, `${repetition}-${arm.name}`),
    repo = join(output, 'repo');
  mkdirSync(output);
  // A clone owns its Git metadata: baseline tools cannot write the source repository's worktree state.
  git(output, ['clone', '--no-hardlinks', '--no-checkout', '--', resolve(manifest.repository), repo]);
  git(repo, ['checkout', '--detach', base]);
  const provisional = { repo, output, result: repo };
  const result = resolve(repo, substitute(arm.resultDirectory, provisional));
  if (relative(output, result).startsWith('..') || isAbsolute(relative(output, result)))
    throw new Error('Benchmark result directory must stay inside its retained arm directory');
  const paths = { repo, output, result };
  const setup = await runCommands(manifest.setup, repo, paths, 'setup');
  if (!setup.passed) return { repetition, arm: arm.name, setup, implementation: null, verification: null, output };
  const implementation = await runCommands(arm.commands, repo, paths, 'implementation');
  const verification = implementation.passed ? await runCommands(manifest.verify, result, paths, 'verification') : null;
  return { repetition, arm: arm.name, setup, implementation, verification, output };
}

/** Runs an explicit manifest without model defaults, source edits, automatic retries or workspace deletion. */
export async function efficiencyBenchmark(input: unknown, parent = tmpdir()) {
  const manifest = manifestSchema.parse(input);
  const base = git(resolve(manifest.repository), ['rev-parse', '--verify', `${manifest.base}^{commit}`]);
  const root = mkdtempSync(join(parent, 'grampus-efficiency-'));
  const rows: Awaited<ReturnType<typeof runArm>>[] = [];
  const result = {
    base,
    root,
    manifest,
    rows,
    note: 'Implementation and verification are separate intervals. Provider tokens require retained provider/Grampus exports; they are not inferred from command output.',
  };
  persist(root, result);
  for (let repetition = 0; repetition < manifest.repetitions; repetition++) {
    // Rotate arm order to avoid always giving one harness the warmest machine state.
    const arms = [
      ...manifest.arms.slice(repetition % manifest.arms.length),
      ...manifest.arms.slice(0, repetition % manifest.arms.length),
    ];
    for (const arm of arms) {
      rows.push(await runArm(manifest, arm, root, base, repetition));
      persist(root, result);
    }
  }
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (!path) throw new Error('Usage: npm run probe:efficiency -- <manifest.json>');
  if (statSync(path).size > processLimits.benchmarkManifestBytes)
    throw new Error('Benchmark manifest exceeds the input limit');
  efficiencyBenchmark(JSON.parse(readFileSync(path, 'utf8')))
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch((error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    });
}
