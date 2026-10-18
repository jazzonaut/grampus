import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { Store } from '../persistence/store.js';
import { Sessions, runSession } from '../execution/sessions.js';
import { inspectReference } from '../repository/reference-folders.js';
import type { Provider } from '../providers/types.js';

async function main() {
  if (!process.argv.includes('--live'))
    throw new Error('Pass --live to check both provider subscriptions with temporary read-only reference fixtures.');
  const id = randomUUID(),
    root = resolve('.grampus/reference-probes', id),
    repo = join(root, 'repo'),
    reference = join(tmpdir(), `grampus reference ${id}`);
  mkdirSync(repo, { recursive: true });
  mkdirSync(reference);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init');
  git('config', 'user.name', 'Reference fixture');
  git('config', 'user.email', 'fixture@invalid');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'entry.txt'), 'The contract is in the selected external reference folder.\n');
  git('add', '.');
  git('commit', '-m', 'Reference fixture');
  const base = git('rev-parse', 'HEAD');
  const marker = randomUUID();
  writeFileSync(join(reference, 'contract.txt'), `reference contract: ${marker}\n`);
  const references = [inspectReference(reference)],
    store = new Store(join(root, 'journal.sqlite')),
    results: unknown[] = [];
  console.log(JSON.stringify({ root }));
  try {
    for (const provider of ['codex', 'claude'] as Provider[]) {
      const session = new Sessions(store).create(provider, repo);
      const result = await runSession(
        store,
        session.id,
        'Read-only integration check. Use grampus_list_files, grampus_search and grampus_read_file with root=reference-1 to discover the reference contract. Use all three tools. Return kind=message containing only the contract UUID, without formatting. Do not modify files or external services.',
        { timeoutMs: 180000, repository: { repo, base, references } },
      );
      const events = store.sessionEvents(session.id).filter(event => event.type === 'repository.tool_result');
      const used = new Set(
        events
          .map(event => (event.data as { data: { root?: string; tool: string } }).data)
          .filter(data => data.root === 'reference-1')
          .map(data => data.tool),
      );
      const passed =
        result.status === 'completed' &&
        result.reply?.text.trim() === marker &&
        ['grampus_list_files', 'grampus_search', 'grampus_read_file'].every(tool => used.has(tool));
      const summary = { provider, passed, status: result.status, error: result.error, tools: [...used] };
      results.push(summary);
      console.log(JSON.stringify(summary));
      writeFileSync(join(root, 'result.json'), JSON.stringify(results, null, 2));
      if (!passed) throw new Error(`Reference probe failed for ${provider}; evidence: ${root}`);
    }
  } finally {
    store.close();
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
