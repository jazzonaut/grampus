import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pinnedRepository, pinnedContext, searchPinnedFiles } from './repository-context.js';
import { deliveryGitInput, gitText, verifyTree } from './delivery-git.js';
import { snapshotRepository } from './artifacts.js';
import { verifyEditingScope } from './edit-policy.js';

/** Offline scale probe. Retains its fixture and timings, starts no providers. */
async function main() {
  const fileArg = process.argv.indexOf('--files');
  const count = Number(fileArg < 0 ? 100000 : process.argv[fileArg + 1]);
  if (!Number.isSafeInteger(count) || count < 1 || count > 100000)
    throw new Error('--files must be between 1 and 100000');
  const bytesArg = process.argv.indexOf('--file-bytes'),
    fileBytes = Number(bytesArg < 0 ? 16 : process.argv[bytesArg + 1]);
  if (!Number.isSafeInteger(fileBytes) || fileBytes < 16 || fileBytes > 32 * 1024 * 1024)
    throw new Error('--file-bytes must be between 16 and 33554432');
  const root = resolve('.grampus', 'context-probes', randomUUID()),
    repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  execFileSync('git', ['init', '-b', 'main', repo], { windowsHide: true, stdio: 'pipe' });
  const source = 'console.log(1);\n' + ' '.repeat(fileBytes - 16),
    rules = 'Keep changes focused.\n';
  const commands = [
    `blob\nmark :1\ndata ${Buffer.byteLength(source)}\n${source}\n`,
    `blob\nmark :2\ndata ${Buffer.byteLength(rules)}\n${rules}\n`,
    'commit refs/heads/main\ncommitter Scale Probe <fixture@invalid> 1700000000 +0000\ndata 12\nScale probe\n\nM 100644 :2 AGENTS.md\nM 100644 :1 target.js\n',
  ];
  for (let index = 0; index < count; index++)
    commands.push(
      `M 100644 :1 modules/m${String(Math.floor(index / 1000)).padStart(3, '0')}/file-${String(index).padStart(6, '0')}.js\n`,
    );
  commands.push('\ndone\n');
  deliveryGitInput(repo, Buffer.from(commands.join('')), 'fast-import', '--quiet');
  const base = gitText(repo, 'rev-parse', 'HEAD'),
    timings: Record<string, number> = {};
  const measure = async <T>(name: string, fn: () => T | Promise<T>): Promise<T> => {
    const start = performance.now(),
      value = await fn();
    timings[name] = Number((performance.now() - start).toFixed(2));
    console.log(`${name}: ${timings[name]} ms`);
    return value;
  };
  const tree = await measure('coldIndex', () => pinnedRepository(repo, base));
  await measure('warmIndex100Reads', () => {
    for (let n = 0; n < 100; n++) pinnedRepository(repo, base);
  });
  const search = await measure('search100Results', () =>
    searchPinnedFiles(repo, base, 'modules', Math.min(50000, Math.max(0, count - 100))),
  );
  const selected = await measure('selectedBlobContext', () => pinnedContext(repo, base, ['target.js']));
  let verified = false;
  if (process.argv.includes('--checkout')) {
    await measure('checkout', () =>
      execFileSync('git', ['-C', repo, '-c', 'core.autocrlf=false', 'reset', '--hard', 'HEAD'], {
        windowsHide: true,
        timeout: 600000,
        stdio: 'pipe',
      }),
    );
    console.log('Hashing the full worktree...');
    const snapshot = await measure('fullSnapshot', () => snapshotRepository(repo, base));
    await measure('scopeVerification', () =>
      verifyEditingScope(
        {
          cwd: repo,
          snapshot,
          policy: {
            artifact: snapshot.artifact,
            instructionsDigest: snapshot.instructionsDigest,
            files: ['target.js'],
          },
        },
        snapshot,
      ),
    );
    await measure('verifyRawCommitTree', () => verifyTree(repo, snapshot, base));
    await measure('verifyRawIndex', () => verifyTree(repo, snapshot));
    verified = true;
  }
  const result = {
    scope: 'Offline synthetic scale probe; no provider inference or ordinary-project delivery',
    repo,
    base,
    files: tree.entries.length,
    bytes: tree.totalBytes,
    searchResults: search.files.length,
    contextBytes: Buffer.byteLength(JSON.stringify(selected)),
    selectedFiles: selected.files.length,
    omittedFiles: selected.summary.omittedFiles,
    verified,
    timings,
    rssMiB: Math.round(process.memoryUsage().rss / 1024 / 1024),
  };
  writeFileSync(join(root, 'result.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
