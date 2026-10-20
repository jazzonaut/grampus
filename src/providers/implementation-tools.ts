// Owns the shared provider contract for requesting controller-run implementation diagnostics.
import { z } from 'zod';
import type { ConnectOptions } from './types.js';
import { repositoryToolLimits } from '../config/limits.js';
import { diagnosticSelectionSchema } from '../domain/diagnostics.js';

/** The one capability selector exposed to implementers; executable and arguments are never agent input. */
export const implementationToolDefinition = {
  name: 'grampus_run_check',
  description:
    'Run an approved command against current edits. Use format, readiness:format, readiness:lint, readiness:types or validation. Diagnostic families use diagnostic:<name> and accept only their approved named parameters and repository files. Wait for settlement before editing. The controller decides whether the result can satisfy a final gate.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      parameters: { type: 'object', additionalProperties: { type: 'string' } },
      files: { type: 'array', items: { type: 'string' } },
    },
    required: ['name'],
    additionalProperties: false,
  },
};

/** Validates a capability selector before any command is looked up or dispatched. */
export function runImplementationTool(
  commands: NonNullable<ConnectOptions['commands']>,
  input: unknown,
): Promise<unknown> {
  const { name, parameters, files } = diagnosticSelectionSchema
    .extend({ name: z.string().min(1).max(repositoryToolLimits.argumentCharacters) })
    .parse(input);
  return commands.run(name, {
    ...(parameters && Object.keys(parameters).length ? { parameters } : {}),
    ...(files?.length ? { files } : {}),
  });
}
