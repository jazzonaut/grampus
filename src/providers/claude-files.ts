import { tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { deleteEditingFile, type EditingContext } from '../execution/edit-policy.js';
import type { AgentEvent } from './types.js';

/** One in-process tool; the worker's turn and durable journal fence every unlink. */
export function claudeDeleteTool(context: EditingContext, emit: (event: AgentEvent) => void, ownsTurn: () => boolean) {
  return tool(
    'delete_file',
    'Delete one exact file from the approved deletion-only list. No directories, wildcards, edits or shell commands.',
    { file_path: z.string().min(1).max(32768) },
    async input => {
      try {
        if (!ownsTurn()) throw new Error('No active implementation turn owns this deletion');
        deleteEditingFile(context, input, emit);
        return { content: [{ type: 'text', text: 'Deleted the authorized file.' }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
    { annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false, openWorldHint: false } },
  );
}
