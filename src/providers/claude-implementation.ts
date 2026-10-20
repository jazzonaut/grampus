// Owns Claude's controller-run diagnostic capability. The handler fences ownership before dispatch
// and after settlement, independently of the SDK's permission callbacks.
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { ConnectOptions } from './types.js';
import { implementationToolDefinition, runImplementationTool } from './implementation-tools.js';
import { processLimits } from '../config/limits.js';

/** The SDK name of the one internal command capability; it is never an external integration. */
export const isImplementationTool = (name: string) => name === 'mcp__grampus_implementation__grampus_run_check';

/** One implementation diagnostic tool, exported separately so its permission fence is testable. */
export function claudeImplementationTool(commands: NonNullable<ConnectOptions['commands']>, owned: () => boolean) {
  return tool(
    implementationToolDefinition.name,
    implementationToolDefinition.description,
    { name: z.string() },
    async input => {
      try {
        if (!owned()) throw new Error('Command requires an active implementation turn');
        const result = await runImplementationTool(commands, input);
        if (!owned()) throw new Error('Command no longer owns its turn');
        return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text' as const, text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  );
}

/** The implementation-only MCP server; its timeout covers command execution and supervisor settlement. */
export function claudeImplementation(commands: NonNullable<ConnectOptions['commands']>, owned: () => boolean) {
  return createSdkMcpServer({
    name: 'grampus_implementation',
    version: '1.0.0',
    alwaysLoad: true,
    timeout: processLimits.implementationCommandToolMs,
    tools: [claudeImplementationTool(commands, owned)],
  });
}
