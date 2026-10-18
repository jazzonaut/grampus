import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { repositoryTools, repositoryToolDefinitions, type RepositoryAccess } from '../repository-tools.js';
import type { AgentEvent } from './types.js';

export const isRepositoryTool = (name: string) => repositoryToolDefinitions.some(def => name === `mcp__grampus_repository__${def.name}`);
export function claudeRepository(access: RepositoryAccess, emit: (event: AgentEvent) => void, ownsTurn: () => boolean) {
  return createSdkMcpServer({ name: 'grampus_repository', version: '1.0.0', alwaysLoad: true, timeout: 30000,
    tools: claudeRepositoryTools(access, emit, ownsTurn) });
}
export function claudeRepositoryTools(access: RepositoryAccess, emit: (event: AgentEvent) => void, ownsTurn: () => boolean) {
  const invoke = repositoryTools(access, emit, ownsTurn);
  const schemas = [
    { query: z.string().optional(), offset: z.number().int().nonnegative().optional(), root: z.string().optional() },
    { path: z.string(), offset: z.number().int().nonnegative().optional(), limit: z.number().int().min(1).max(400).optional(), root: z.string().optional() },
    { query: z.string().min(1), path: z.string().optional(), offset: z.number().int().nonnegative().optional(), root: z.string().optional() },
    { path: z.string(), reason: z.string() },
  ];
  return repositoryToolDefinitions.map((def, index) => tool(def.name, def.description, schemas[index]!, async input => {
      try { return { content: [{ type: 'text' as const, text: JSON.stringify(invoke(def.name, input)) }] }; }
      catch (error) { return { isError: true, content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }] }; }
    }, { annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));
}
