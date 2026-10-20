// Owns the approval-bound declaration of additional local inputs required for check reuse.
import { z } from 'zod';
import { commandLimits } from '../config/limits.js';

/** A local deterministic check depends only on its artifact, runtime, environment and these input trees. */
export const checkReuseSchema = z.strictObject({
  inputs: z
    .array(
      z
        .string()
        .min(1)
        .max(commandLimits.argsCharacters)
        .refine(
          path =>
            !path.includes('\\') &&
            [...path].every(character => character.charCodeAt(0) >= 0x20) &&
            !path.startsWith('/') &&
            !path.includes(':') &&
            path.split('/').every(part => part !== '..' && part !== '.' && part.length > 0),
        ),
    )
    .max(commandLimits.reuseInputRoots),
});
