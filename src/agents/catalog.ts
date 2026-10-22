// What models and effort levels each agent offers, for the recipe editor. Codex prints its catalog as
// JSON (`codex debug models`); Claude Code has no catalog command, so its model aliases and effort levels
// are read from `claude --help` and joined with models seen in recipes and measurements. Help text is
// not a contract: when it cannot be read the list is shorter, never wrong, and a model can still be typed.
import { z } from 'zod';
import { currentSettings } from '../config/settings.js';
import type { Agent } from '../domain/recipe.js';
import { runCommandLine } from '../process/run.js';

export interface ModelChoice {
  id: string;
  label: string;
  /** Effort levels this model accepts; empty when unknown. */
  efforts: string[];
  defaultEffort: string | null;
}

export interface AgentCatalog {
  agent: Agent;
  models: ModelChoice[];
  /** Effort levels the agent accepts for any model, when it says so. */
  efforts: string[];
  /** Why the list is incomplete, if it is. */
  note: string | null;
}

const catalogTimeoutMs = 30_000;

const codexCatalogSchema = z.object({
  models: z.array(
    z.object({
      slug: z.string(),
      display_name: z.string().optional(),
      visibility: z.string().optional(),
      default_reasoning_level: z.string().nullable().optional(),
      supported_reasoning_levels: z.array(z.object({ effort: z.string() })).optional(),
    }),
  ),
});

/** Run an agent CLI with fixed arguments and return what it printed. */
async function runAgent(command: readonly string[], args: readonly string[]): Promise<string> {
  const result = await runCommandLine(command, args, { timeoutMs: catalogTimeoutMs });
  const name = command[0] ?? '';
  if (result.timedOut) throw new Error(`${name} did not answer within ${catalogTimeoutMs} ms.`);
  if (result.exitCode !== 0) throw new Error(`${name} exited ${result.exitCode}: ${result.stderr.trim().slice(-300)}`);
  return result.stdout;
}

/** Codex's listed models with their effort levels, from its JSON catalog. */
export function parseCodexCatalog(json: string): ModelChoice[] {
  return codexCatalogSchema
    .parse(JSON.parse(json))
    .models.filter(model => model.visibility === undefined || model.visibility === 'list')
    .map(model => ({
      id: model.slug,
      label: model.display_name ?? model.slug,
      efforts: (model.supported_reasoning_levels ?? []).map(level => level.effort),
      defaultEffort: model.default_reasoning_level ?? null,
    }));
}

/** Model aliases and effort levels from `claude --help`, or empty lists when the text has changed. */
export function parseClaudeHelp(help: string): { aliases: string[]; efforts: string[] } {
  const flat = help.replace(/\s+/g, ' ');
  const efforts = /--effort <level>[^(]*\(([^)]+)\)/.exec(flat)?.[1];
  const aliases = /--model <model>[^(]*\(e\.g\. ([^)]+)\)/.exec(flat)?.[1];
  return {
    efforts: efforts
      ? efforts
          .split(',')
          .map(word => word.trim())
          .filter(Boolean)
      : [],
    aliases: aliases ? [...aliases.matchAll(/'([^']+)'/g)].map(match => match[1] ?? '').filter(Boolean) : [],
  };
}

async function codexCatalog(): Promise<AgentCatalog> {
  try {
    const models = parseCodexCatalog(await runAgent(currentSettings().codexCommand, ['debug', 'models']));
    return { agent: 'codex', models, efforts: [...new Set(models.flatMap(model => model.efforts))], note: null };
  } catch (error) {
    return { agent: 'codex', models: [], efforts: [], note: `Codex catalog unavailable: ${(error as Error).message}` };
  }
}

async function claudeCatalog(seen: readonly string[]): Promise<AgentCatalog> {
  let help = { aliases: [] as string[], efforts: [] as string[] };
  let note: string | null = null;
  try {
    help = parseClaudeHelp(await runAgent(currentSettings().claudeCommand, ['--help']));
    if (!help.aliases.length)
      note = 'Claude Code did not list its model aliases; type a model name if yours is missing.';
  } catch (error) {
    note = `Claude Code is unavailable: ${(error as Error).message}`;
  }
  const ids = [...new Set([...help.aliases, ...seen])];
  return {
    agent: 'claude',
    models: ids.map(id => ({
      id,
      label: help.aliases.includes(id) ? `${id} (latest)` : id,
      efforts: help.efforts,
      defaultEffort: null,
    })),
    efforts: help.efforts,
    note,
  };
}

/** Both agents' catalogs. `seenClaudeModels` are Claude models named in recipes or measured in tasks. */
export async function agentCatalogs(seenClaudeModels: readonly string[]): Promise<AgentCatalog[]> {
  return Promise.all([claudeCatalog(seenClaudeModels), codexCatalog()]);
}
