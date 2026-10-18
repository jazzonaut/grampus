import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Store } from './store.js';
import { Sessions, runSession } from './sessions.js';
import { snapshotRepository } from './artifacts.js';
import type { Provider } from './agents/types.js';

async function main() {
  if (!process.argv.includes('--live')) throw new Error('Pass --live to use the existing Codex and Claude subscription logins. Fixtures are retained under .grampus/exploration-probes.');
  const providerArg = process.argv.find(arg => arg.startsWith('--provider='))?.split('=')[1];
  if (providerArg && providerArg !== 'codex' && providerArg !== 'claude') throw new Error('Provider must be codex or claude');
  const root = resolve('.grampus/exploration-probes', randomUUID()), repo = join(root, 'repo'); mkdirSync(join(repo, 'src'), { recursive: true });
  const git = (...args: string[]) => execFileSync('git', ['-C', repo, ...args], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
  git('init'); git('config', 'user.name', 'Exploration fixture'); git('config', 'user.email', 'fixture@invalid'); git('config', 'core.autocrlf', 'false');
  const first = randomUUID(), second = randomUUID();
  writeFileSync(join(repo, 'src', 'entry.cjs'), 'module.exports = require("./contract.cjs");\n');
  writeFileSync(join(repo, 'src', 'contract.cjs'), `module.exports = { contract: '${first}' };\n`);
  git('add', '.'); git('commit', '-m', 'Exploration fixture'); const base = git('rev-parse', 'HEAD');
  // Planning must read the pinned tree, even though the checkout has different bytes.
  writeFileSync(join(repo, 'src', 'contract.cjs'), `module.exports = { contract: '${second}' };\n`);
  const store = new Store(join(root, 'journal.sqlite'));
  console.log(JSON.stringify({ root, note: 'Live subscription exploration; no external actions or task delivery' }));
  const results: unknown[] = [];
  try {
    for (const provider of (providerArg ? [providerArg] : ['codex', 'claude']) as Provider[]) {
      const session = new Sessions(store).create(provider, repo);
      for (const stage of ['pinned', 'resumed', 'snapshot'] as const) {
        const before = store.sessionEvents(session.id).length;
        const snapshot = stage === 'snapshot' ? await snapshotRepository(repo, base) : null;
        const result = await runSession(store, session.id,
          'Repository exploration integration check. Use grampus_list_files, grampus_search and grampus_read_file to find the contract exported by the dependency of the entry module. You MUST use all three tools during this turn, even if you remember an earlier answer. Return kind=message with text containing ONLY the exact contract string, without quotes or formatting. No edits.',
          { timeoutMs: 180000, repository: snapshot ? { repo, snapshot } : { repo, base } });
        const events = store.sessionEvents(session.id).slice(before).filter(event => event.type === 'repository.tool_result');
        const used = new Set(events.map(event => (event.data as { data: { tool: string } }).data.tool));
        const passed = result.status === 'completed' && result.reply?.text.trim() === (snapshot ? second : first)
          && ['grampus_list_files', 'grampus_search', 'grampus_read_file'].every(tool => used.has(tool));
        const summary = { provider, stage, passed, status: result.status, error: result.error, tools: [...used] };
        results.push(summary); console.log(JSON.stringify(summary));
        writeFileSync(join(root, 'result.json'), JSON.stringify(results, null, 2));
        if (!passed) throw new Error(`Exploration failed for ${provider}/${stage}. Evidence: ${root}`);
      }
    }
  } finally { store.close(); }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
