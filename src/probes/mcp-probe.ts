import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { execFileSync } from 'node:child_process';
import { Store } from '../persistence/store.js';
import { Sessions, runSession } from '../execution/sessions.js';

if (process.argv.includes('--fixture-server')) {
  const marker = process.argv[process.argv.indexOf('--fixture-server') + 1];
  createInterface({ input: process.stdin }).on('line', line => {
    const request = JSON.parse(line);
    if (request.id === undefined) return;
    const result =
      request.method === 'initialize'
        ? {
            protocolVersion: request.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'read-only-fixture', version: '1.0.0' },
          }
        : request.method === 'tools/list'
          ? {
              tools: [
                {
                  name: 'read_contract',
                  description: 'Read the integration fixture contract.',
                  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
                  annotations: { readOnlyHint: true, destructiveHint: false },
                },
              ],
            }
          : request.method === 'tools/call'
            ? { content: [{ type: 'text', text: marker }] }
            : {};
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: request.id, result })}\n`);
  });
} else {
  async function main() {
    if (!process.argv.includes('--live'))
      throw new Error(
        'Pass --live to exercise configured Codex MCPs and a Claude project MCP fixture using subscriptions. No external writes are requested.',
      );
    const root = resolve('.grampus/mcp-probes', randomUUID()),
      source = join(root, 'source'),
      cwd = join(root, 'workspace');
    mkdirSync(join(source, '.claude'), { recursive: true });
    mkdirSync(cwd);
    const marker = randomUUID();
    writeFileSync(
      join(source, '.mcp.json'),
      JSON.stringify({
        mcpServers: {
          fixture_reference: {
            command: process.execPath,
            args: [fileURLToPath(import.meta.url), '--fixture-server', marker],
          },
        },
      }),
    );
    writeFileSync(join(source, '.claude', 'settings.local.json'), JSON.stringify({ enableAllProjectMcpServers: true }));
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', source, ...args], { windowsHide: true, encoding: 'utf8', stdio: 'pipe' }).trim();
    git('init');
    git('config', 'user.name', 'MCP fixture');
    git('config', 'user.email', 'fixture@invalid');
    git('add', '.');
    git('commit', '-m', 'MCP project fixture');
    const base = git('rev-parse', 'HEAD'),
      store = new Store(join(root, 'grampus.sqlite'));
    const results: unknown[] = [];
    console.log(JSON.stringify({ root }));
    try {
      if (!process.argv.includes('--claude-only')) {
        const codex = new Sessions(store).create('codex', cwd);
        const result = await runSession(
          store,
          codex.id,
          'Use the configured Linear MCP to read NXT-772. This is a read-only connection check: do not update, comment, message or change anything. Return kind=message with the exact issue identifier and title in text.',
          { timeoutMs: 180000 },
        );
        const summary = {
          provider: 'codex',
          passed: result.status === 'completed' && !!result.reply?.text.includes('NXT-772'),
          result,
        };
        results.push(summary);
        console.log(JSON.stringify(summary));
        if (!summary.passed) throw new Error('Configured Codex Linear MCP check failed');
      }
      const claude = new Sessions(store).create('claude', cwd);
      const result = await runSession(
        store,
        claude.id,
        'Use ToolSearch to find fixture_reference.read_contract in the configured MCP integrations, then call that MCP tool. Do not inspect any local files to obtain its answer. Return kind=message with ONLY the exact contract string in text.',
        { timeoutMs: 180000, repository: { repo: source, base } },
      );
      const called = store
        .sessionEvents(claude.id)
        .some(
          event =>
            event.type === 'integration.tool_authorized' &&
            String((event.data as { data: { tool: string } }).data.tool).endsWith('__read_contract'),
        );
      const summary = {
        provider: 'claude',
        passed: result.status === 'completed' && result.reply?.text.trim() === marker && called,
        result,
      };
      results.push(summary);
      console.log(JSON.stringify(summary));
      writeFileSync(join(root, 'result.json'), JSON.stringify(results, null, 2));
      if (!summary.passed) throw new Error('Claude project MCP inheritance/tool-discovery check failed');
    } finally {
      store.close();
    }
  }
  main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
