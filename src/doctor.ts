import { command, RpcProcess } from './process.js';
import { orcaExecutable } from './orca.js';

export interface Capability {
  component: string;
  status: 'available' | 'unavailable';
  detail: Record<string, unknown>;
}

async function inspect(component: string, check: () => Promise<Record<string, unknown>>): Promise<Capability> {
  try { return { component, status: 'available', detail: await check() }; }
  catch (error) {
    return { component, status: 'unavailable', detail: { error: error instanceof Error ? error.message : String(error) } };
  }
}

export { orcaExecutable } from './orca.js';

export async function doctor(includeOrca: boolean): Promise<Capability[]> {
  const checks = [
    inspect('git', async () => ({ version: await command('git', ['--version']) })),
    inspect('codex', async () => {
      const executable = process.env.GRAMPUS_CODEX_COMMAND ?? 'codex';
      const version = await command(executable, ['--version']);
      const rpc = new RpcProcess(executable, ['app-server', '--listen', 'stdio://']);
      try {
        await rpc.request('initialize', { clientInfo: { name: 'grampus', title: 'Grampus', version: '0.1.0' } });
        rpc.notify('initialized');
        const result = await rpc.request<{ account: { type: string } | null }>('account/read', { refreshToken: false });
        return { version, protocol: 'app-server stdio handshake verified', authType: result.account?.type ?? 'not signed in', inference: 'not tested' };
      } finally { await rpc.close(); }
    }),
    inspect('claude', async () => {
      const executable = process.env.GRAMPUS_CLAUDE_COMMAND ?? 'claude';
      const version = await command(executable, ['--version']);
      const auth = JSON.parse(await command(executable, ['auth', 'status'])) as { loggedIn: boolean; authMethod?: string; apiProvider?: string };
      // Deliberately exclude email, org identity, filesystem paths and credentials.
      return { version, signedIn: auth.loggedIn, authType: auth.authMethod ?? 'unknown', provider: auth.apiProvider ?? 'unknown', inference: 'not tested' };
    }),
  ];
  if (includeOrca) checks.push(inspect('orca', async () => {
    const executable = orcaExecutable();
    const version = await command(executable, ['--version']);
    const response = JSON.parse(await command(executable, ['worktree', 'current', '--json'])) as {
      ok: boolean; result?: { worktree?: { id: string } }; error?: unknown;
    };
    if (!response.ok) throw new Error('Orca could not resolve the current worktree');
    return { version, currentWorktreeRecognized: Boolean(response.result?.worktree?.id), agentLifecycle: 'not tested' };
  }));
  return Promise.all(checks);
}
