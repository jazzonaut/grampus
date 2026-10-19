import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { repositoryTools, repositoryToolDefinitions, type RepositoryAccess } from '../repository/repository-tools.js';
import type { AgentEvent } from './types.js';
import { repositoryToolLimits } from '../config/limits.js';

const pageLimit = () => z.number().int().min(1).max(repositoryToolLimits.pageCharacters).optional();

export const isRepositoryTool = (name: string) =>
  repositoryToolDefinitions.some(def => name === `mcp__grampus_repository__${def.name}`);
export function claudeRepository(access: RepositoryAccess, emit: (event: AgentEvent) => void, ownsTurn: () => boolean) {
  return createSdkMcpServer({
    name: 'grampus_repository',
    version: '1.0.0',
    alwaysLoad: true,
    timeout: repositoryToolLimits.mcpTimeoutMs,
    tools: claudeRepositoryTools(access, emit, ownsTurn),
  });
}
export function claudeRepositoryTools(
  access: RepositoryAccess,
  emit: (event: AgentEvent) => void,
  ownsTurn: () => boolean,
) {
  const invoke = repositoryTools(access, emit, ownsTurn);
  // The input shapes advertised to Claude, by tool name; repository-tool-arguments.ts enforces them again.
  const schemas = {
    grampus_list_files: {
      query: z.string().optional(),
      offset: z.number().int().nonnegative().optional(),
      root: z.string().optional(),
    },
    grampus_read_file: {
      path: z.string(),
      mode: z.enum(['lines', 'characters']).optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: pageLimit(),
      root: z.string().optional(),
    },
    grampus_search: {
      query: z.string().min(1),
      path: z.string().optional(),
      offset: z.number().int().nonnegative().optional(),
      root: z.string().optional(),
    },
    grampus_suggest_reference_folder: { path: z.string(), reason: z.string() },
    grampus_read_changes: {
      path: z.string().optional(),
      side: z.enum(['before', 'after']).optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: pageLimit(),
    },
    grampus_read_check: {
      checkId: z.string().optional(),
      stream: z.enum(['stdout', 'stderr', 'spec']).optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: pageLimit(),
    },
    grampus_read_dependency: {
      package: z.string(),
      path: z.string().optional(),
      from: z.string().optional(),
      query: z.string().optional(),
      offset: z.number().int().nonnegative().optional(),
      limit: pageLimit(),
    },
  };
  const named = (name: string): name is keyof typeof schemas => Object.hasOwn(schemas, name);
  return repositoryToolDefinitions.map(def => {
    if (!named(def.name)) throw new Error(`Repository tool ${def.name} has no Claude input schema`);
    return tool(
      def.name,
      def.description,
      schemas[def.name],
      input => {
        try {
          return Promise.resolve({
            content: [{ type: 'text' as const, text: JSON.stringify(invoke(def.name, input)) }],
          });
        } catch (error) {
          return Promise.resolve({
            isError: true,
            content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
          });
        }
      },
      { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } },
    );
  });
}
