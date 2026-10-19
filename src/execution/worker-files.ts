// Pins the files exchanged between the controller and its supervised workers. The controller writes a
// request file and the worker reads it; the implementation worker writes `result.json` and the
// controller reads it after confirmed exit. These cross a process boundary and may be left behind by an
// interrupted run, so each read is validated. A request that fails stops the worker before any provider
// or Git work; a result that fails is recorded as the run's error and never accepted as a reply.
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { parseJson, validateInPlace, type BoundaryContext } from '../process/boundary.js';
import { turnResultSchema } from '../providers/reply-schema.js';
import { deliveryRequestSchema, type DeliveryRequest } from '../persistence/records.js';

/** The implementation worker's request. Settings are validated by `parseSettings`. */
export const implementationRequestFileSchema = z.object({
  database: z.string(),
  id: z.string(),
  prompt: z.string(),
  settings: z.unknown(),
});
export type ImplementationRequestFile = z.infer<typeof implementationRequestFileSchema>;

/** `result.json`: the turn result, bound to the run id that produced it. */
export const implementationResultFileSchema = z.object({ id: z.string(), result: turnResultSchema });
export type ImplementationResultFile = z.infer<typeof implementationResultFileSchema>;

function readJson(path: string, context: BoundaryContext): unknown {
  return parseJson(readFileSync(path, 'utf8'), context);
}

/** Read and validate the implementation worker's request file. */
export function readImplementationRequest(path: string): ImplementationRequestFile {
  const context = { kind: 'worker-request', source: 'implementation request' } as const;
  return validateInPlace(implementationRequestFileSchema, readJson(path, context), context);
}

/**
 * Read and validate the delivery worker's request file. Validated in place: the worker compares it
 * with the journal's copy by its serialised bytes before any Git write.
 */
export function readDeliveryRequest(path: string): DeliveryRequest {
  const context = { kind: 'worker-request', source: 'delivery request' } as const;
  return validateInPlace(deliveryRequestSchema, readJson(path, context), context);
}

/** Read and validate an implementation worker's `result.json`. */
export function readImplementationResult(path: string): ImplementationResultFile {
  const context = { kind: 'supervisor-receipt', source: 'implementation result.json' } as const;
  return validateInPlace(implementationResultFileSchema, readJson(path, context), context);
}
