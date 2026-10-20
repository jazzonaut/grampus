// Owns inference-free discovery from the same local agents used for task execution. These catalogues
// are suggestions, never proof that an account can run a model; failures leave manual entry available.
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { healthLimits, providerLimits } from '../config/limits.js';
import { reasoningEffortSchema } from '../domain/model-profiles.js';
import type { RpcProcess } from '../process/process.js';
import { ClaudeSession } from './claude.js';
import { codexHandshake, startCodexAppServer } from './codex.js';

/** A selectable model and the efforts reported by its local provider; null means unspecified. */
export interface ProviderModel {
  id: string;
  label: string;
  efforts: string[] | null;
}

/** Independent catalogue results so one unavailable agent does not hide the other. */
export interface ProviderModels {
  codex: { models: ProviderModel[]; problem: string | null };
  claude: { models: ProviderModel[]; problem: string | null };
}

const codexPage = z.object({
  data: z
    .array(
      z.object({
        model: z.string().min(1),
        displayName: z.string(),
        hidden: z.boolean(),
        supportedReasoningEfforts: z.array(z.object({ reasoningEffort: z.string() })),
      }),
    )
    .max(providerLimits.modelListPage),
  nextCursor: z.string().nullable(),
});
const claudeModels = z
  .array(
    z.object({
      value: z.string().min(1),
      displayName: z.string(),
      supportsEffort: z.boolean().optional(),
      supportedEffortLevels: z.array(reasoningEffortSchema).optional(),
    }),
  )
  .max(providerLimits.modelListTotal);

/** Reads every visible Codex model page with a fixed bound, refusing an incomplete catalogue. */
export async function readCodexModels(rpc: Pick<RpcProcess, 'request'>): Promise<ProviderModel[]> {
  const models: ProviderModel[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < providerLimits.modelListPages; page++) {
    const result = codexPage.parse(
      await rpc.request('model/list', {
        limit: providerLimits.modelListPage,
        cursor,
        includeHidden: false,
      }),
    );
    models.push(
      ...result.data
        .filter(model => !model.hidden)
        .map(model => ({
          id: model.model,
          label: model.displayName,
          // A new advisory effort must not hide every model or expand the controller's supported protocol.
          efforts: model.supportedReasoningEfforts
            .map(effort => effort.reasoningEffort)
            .filter(effort => reasoningEffortSchema.safeParse(effort).success),
        })),
    );
    cursor = result.nextCursor;
    if (cursor === null) return models;
  }
  throw new Error('Model catalogue pagination did not finish');
}

/** Normalises the SDK control response while leaving unreported effort support unknown. */
export async function readClaudeModels(session: { supportedModels(): Promise<unknown> }): Promise<ProviderModel[]> {
  return claudeModels.parse(await session.supportedModels()).map(model => ({
    id: model.value,
    label: model.displayName,
    efforts: model.supportsEffort === false ? [] : (model.supportedEffortLevels ?? null),
  }));
}

async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Model discovery timed out')), healthLimits.handshakeTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function codex(): Promise<ProviderModel[]> {
  const rpc = startCodexAppServer(tmpdir());
  try {
    return await bounded(
      (async () => {
        await codexHandshake(rpc);
        return readCodexModels(rpc);
      })(),
    );
  } finally {
    await rpc.close();
  }
}

async function claude(): Promise<ProviderModel[]> {
  const session = new ClaudeSession({
    cwd: tmpdir(),
    providerSessionId: null,
    model: null,
    signal: new AbortController().signal,
    emit: () => {},
  });
  try {
    return await bounded(readClaudeModels(session));
  } finally {
    await session.close();
  }
}

/** Queries both local agents without sending a prompt or starting a turn. Raw errors stay private. */
export async function discoverProviderModels(
  readers: { codex(): Promise<ProviderModel[]>; claude(): Promise<ProviderModel[]> } = { codex, claude },
): Promise<ProviderModels> {
  const results = await Promise.allSettled([readers.codex(), readers.claude()]);
  const result = (value: PromiseSettledResult<ProviderModel[]>): ProviderModels['codex'] =>
    value.status === 'fulfilled'
      ? { models: value.value, problem: null }
      : { models: [], problem: 'Model discovery unavailable. Enter a model ID manually or use the provider default.' };
  return { codex: result(results[0]), claude: result(results[1]) };
}
