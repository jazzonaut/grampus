// Owns the shared provider contract for requesting controller-run implementation diagnostics.
import { z } from 'zod';
import type { ConnectOptions } from './types.js';
import { repositoryToolLimits } from '../config/limits.js';

/** The one capability selector exposed to implementers; executable and arguments are never agent input. */
export const implementationToolDefinition = {
  name: 'grampus_run_check',
  description:
    'Run one approved command against your current edits. Use name=format for the approved formatter, readiness:format, readiness:lint or readiness:types for mechanical checks, or validation for behavioural tests. Wait for the result before editing. Final controller checks still run after your last edit.',
  inputSchema: {
    type: 'object',
    properties: { name: { type: 'string' } },
    required: ['name'],
    additionalProperties: false,
  },
};

/** Validates a capability selector before any command is looked up or dispatched. */
export function runImplementationTool(
  commands: NonNullable<ConnectOptions['commands']>,
  input: unknown,
): Promise<unknown> {
  const { name } = z
    .strictObject({ name: z.string().min(1).max(repositoryToolLimits.argumentCharacters) })
    .parse(input);
  return commands.run(name);
}
