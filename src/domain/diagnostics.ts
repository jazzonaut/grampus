// Owns approved diagnostic command families: agents choose bounded parameters and repository files,
// while the executable, argument prefix, parameter grammar and deadline remain approval-bound.
import { z } from 'zod';
import { commandLimits } from '../config/limits.js';

const literal = z
  .string()
  .min(1)
  .max(commandLimits.argsCharacters)
  .refine(value => [...value].every(character => character.charCodeAt(0) >= 0x20));
/** One named option. Its flag is fixed; values can be constrained to an approved list. */
export const diagnosticParameterSchema = z.strictObject({
  name: literal,
  flag: literal.refine(value => /^--?[a-zA-Z][a-zA-Z0-9-]*$/.test(value)),
  values: z.array(literal).min(1).max(commandLimits.diagnosticParameters).exactOptional(),
});
/** The parameter grammar attached to an approved command. File suffixes bound selectable inventory paths. */
export const diagnosticGrammarSchema = z.strictObject({
  parameters: z.array(diagnosticParameterSchema).max(commandLimits.diagnosticParameters),
  fileSuffixes: z
    .array(literal.refine(value => value.startsWith('.') && !/[\\/]/.test(value)))
    .max(commandLimits.diagnosticParameters),
});
export type DiagnosticGrammar = z.infer<typeof diagnosticGrammarSchema>;

/** A single diagnostic selection; unknown keys and executable overrides are refused. */
export const diagnosticSelectionSchema = z.strictObject({
  parameters: z.record(z.string(), literal).optional(),
  files: z.array(literal).max(commandLimits.diagnosticFiles).optional(),
});
export type DiagnosticSelection = z.infer<typeof diagnosticSelectionSchema>;

/** Resolves a selection to literal arguments without interpreting shell text or guessing runner options. */
export function diagnosticArguments(
  grammar: DiagnosticGrammar,
  selection: DiagnosticSelection,
  inventory: ReadonlySet<string>,
): string[] {
  const args: string[] = [];
  const parameters = selection.parameters ?? {};
  if (Object.keys(parameters).some(name => !grammar.parameters.some(item => item.name === name)))
    throw new Error('Unknown diagnostic parameter');
  for (const item of grammar.parameters) {
    const value = parameters[item.name];
    if (value === undefined) continue;
    if (value.startsWith('-') || (item.values && !item.values.includes(value)))
      throw new Error('Unapproved diagnostic value');
    args.push(item.flag, value);
  }
  for (const path of selection.files ?? []) {
    if (path.startsWith('-') || !inventory.has(path) || !grammar.fileSuffixes.some(suffix => path.endsWith(suffix)))
      throw new Error('Diagnostic files must match approved suffixes and the current repository inventory');
    args.push(path);
  }
  if (JSON.stringify(args).length > commandLimits.argsCharacters)
    throw new Error('Diagnostic arguments exceed the current limit');
  return args;
}
