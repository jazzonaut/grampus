import { command, RpcProcess } from '../process/process.js';
import { orcaExecutable } from '../repository/orca.js';
import { applicationVersion } from '../config/runtime.js';
import { parseJson } from '../process/boundary.js';
import { accountReadSchema, parseCodexResponse } from '../providers/codex-protocol.js';
import { claudeAuthStatusSchema, parseClaudeMessage } from '../providers/claude-protocol.js';
import { orcaCurrentSchema, orcaEnvelopeSchema, orcaJson, parseOrca } from '../repository/orca-protocol.js';

export interface Capability {
  component: string;
  status: 'available' | 'unavailable';
  detail: Record<string, unknown>;
}

async function inspect(component: string, check: () => Promise<Record<string, unknown>>): Promise<Capability> {
  try {
    return { component, status: 'available', detail: await check() };
  } catch (error) {
    return {
      component,
      status: 'unavailable',
      detail: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

export { orcaExecutable } from '../repository/orca.js';

export async function doctor(includeOrca: boolean): Promise<Capability[]> {
  const checks = [
    inspect('git', async () => ({ version: await command('git', ['--version']) })),
    inspect('codex', async () => {
      const executable = process.env.GRAMPUS_CODEX_COMMAND ?? 'codex';
      const version = await command(executable, ['--version']);
      const rpc = new RpcProcess(executable, ['app-server', '--listen', 'stdio://']);
      try {
        await rpc.request('initialize', {
          clientInfo: { name: 'grampus', title: 'Grampus', version: applicationVersion },
        });
        rpc.notify('initialized');
        const result = parseCodexResponse(
          'account/read',
          accountReadSchema,
          await rpc.request('account/read', { refreshToken: false }),
        );
        return {
          version,
          protocol: 'app-server stdio handshake verified',
          authType: result.account?.type ?? 'not signed in',
          inference: 'not tested',
        };
      } finally {
        await rpc.close();
      }
    }),
    inspect('claude', async () => {
      const executable = process.env.GRAMPUS_CLAUDE_COMMAND ?? 'claude';
      const version = await command(executable, ['--version']);
      const auth = parseClaudeMessage(
        'auth status',
        claudeAuthStatusSchema,
        parseJson(await command(executable, ['auth', 'status']), {
          kind: 'provider-protocol',
          source: 'claude auth status',
        }),
      );
      // Deliberately exclude email, org identity, filesystem paths and credentials.
      return {
        version,
        signedIn: auth.loggedIn,
        authType: auth.authMethod ?? 'unknown',
        provider: auth.apiProvider ?? 'unknown',
        inference: 'not tested',
      };
    }),
  ];
  if (includeOrca)
    checks.push(
      inspect('orca', async () => {
        const executable = orcaExecutable();
        const version = await command(executable, ['--version']);
        const response = parseOrca(
          'worktree current',
          orcaEnvelopeSchema,
          orcaJson('worktree current', await command(executable, ['worktree', 'current', '--json'])),
        );
        if (!response.ok) throw new Error('Orca could not resolve the current worktree');
        const current = parseOrca('worktree current', orcaCurrentSchema, response.result);
        return {
          version,
          currentWorktreeRecognized: Boolean(current.worktree?.id),
          agentLifecycle: 'not tested',
        };
      }),
    );
  return Promise.all(checks);
}
