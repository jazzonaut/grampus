// Prepare a fresh task checkout without changing repository-wide Git configuration.
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, uncommittedPaths } from './git.js';

/** Materialise committed text consistently before tools and workers inspect the base. */
export async function prepareCheckout(cwd: string): Promise<void> {
  if ((await uncommittedPaths(cwd)).length) throw new Error('Checkout preparation requires a clean worktree.');
  const entries = (await git(cwd, ['ls-files', '--eol', '-z'])).split('\0');
  for (const entry of entries) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const metadata = entry.slice(0, tab);
    if (!/^i\/lf\s+w\/crlf\s+/.test(metadata) || /eol=crlf/.test(metadata)) continue;
    const path = join(cwd, entry.slice(tab + 1));
    if (!lstatSync(path).isFile()) continue;
    // Latin-1 is a reversible byte mapping, so this cannot corrupt non-UTF-8 text.
    const content = readFileSync(path).toString('latin1');
    writeFileSync(path, Buffer.from(content.replaceAll('\r\n', '\n'), 'latin1'));
    // Refresh Git's cached checkout representation; the normalised blob is identical.
    await git(cwd, ['add', '--renormalize', '--', entry.slice(tab + 1)]);
  }
  if ((await uncommittedPaths(cwd)).length) throw new Error('Checkout preparation did not leave a clean worktree.');
}
