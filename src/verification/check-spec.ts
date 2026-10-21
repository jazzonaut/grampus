// Owns validation of approved check requests before any workspace ownership or dispatch.
import { isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { commandLimits } from '../config/limits.js';
import type { CheckSpec } from '../persistence/records.js';
import { validateEditPolicy } from '../execution/edit-policy.js';
import { validateExpectations } from '../domain/acceptance.js';
import { checkReuseSchema } from '../domain/check-input-policy.js';
import { restorePolicySchema } from '../domain/restore-policy.js';
const checkOptions = [
  'name',
  'file',
  'args',
  'timeoutMs',
  'artifact',
  'instructionsDigest',
  'criteria',
  'expectedStdout',
  'expectations',
  'preparation',
  'readiness',
  'reuse',
  'restore',
];

/**
 * A preparation check takes only a file scope (validated as an edit policy on the checked artifact)
 * and never maps criteria, so it can never stand in for acceptance.
 */
function validatePreparation(spec: CheckSpec): void {
  if (spec.preparation === undefined) return;
  if (
    !spec.preparation ||
    typeof spec.preparation !== 'object' ||
    Array.isArray(spec.preparation) ||
    Object.keys(spec.preparation).some(key => key !== 'scope') ||
    spec.criteria !== undefined
  )
    throw new Error('Invalid preparation options');
  if (spec.preparation.scope !== undefined)
    validateEditPolicy({
      ...spec.preparation.scope,
      artifact: spec.artifact,
      instructionsDigest: spec.instructionsDigest,
    });
}

/** Criteria make a check an acceptance check, which alone may carry output assertions. */
function validateCriteria(spec: CheckSpec): void {
  validateReuse(spec);
  if (spec.reuse) checkReuseSchema.parse(spec.reuse);
  if (spec.reuse && spec.criteria) throw new Error('Acceptance cannot reuse implementation diagnostics');
  if (
    spec.readiness !== undefined &&
    (!['format', 'lint', 'types'].includes(spec.readiness) ||
      spec.criteria !== undefined ||
      spec.preparation !== undefined)
  )
    throw new Error('Readiness requires a mechanical kind and cannot be preparation or acceptance');
  if (
    spec.criteria !== undefined &&
    (!Array.isArray(spec.criteria) ||
      spec.criteria.length === 0 ||
      spec.criteria.some(value => typeof value !== 'string' || !value.trim()) ||
      new Set(spec.criteria).size !== spec.criteria.length)
  )
    throw new Error('Verification requires distinct acceptance criteria');
  if (spec.criteria !== undefined) validateExpectations(spec.expectedStdout, spec.expectations);
  else if (spec.expectedStdout !== undefined || spec.expectations !== undefined)
    throw new Error('Ordinary checks do not accept output assertions');
}

/** An existing absolute executable (an `.exe` on Windows) with literal, bounded string arguments. */
function validateCommand(spec: CheckSpec): void {
  if (
    typeof spec.file !== 'string' ||
    !isAbsolute(spec.file) ||
    !statSync(spec.file).isFile() ||
    (process.platform === 'win32' && !spec.file.toLowerCase().endsWith('.exe'))
  )
    throw new Error('Check file must be an absolute executable path; invoke scripts through their interpreter');
  if (
    !Array.isArray(spec.args) ||
    spec.args.some(value => typeof value !== 'string' || value.includes('\0')) ||
    spec.file.includes('\0')
  )
    throw new Error('Check arguments must be strings without NUL');
  if (JSON.stringify(spec.args).length > commandLimits.argsCharacters)
    throw new Error('Check arguments exceed the current limit');
}

/**
 * Validates a check request before it claims anything: a known option set, an absolute executable
 * (scripts run through their interpreter, never a shell), literal bounded arguments, a bounded
 * timeout and the current-format artifact and instructions digests it is bound to.
 */
export function validateCheck(spec: CheckSpec): void {
  if (!spec || typeof spec.name !== 'string' || !spec.name.trim() || spec.name.length > commandLimits.nameCharacters)
    throw new Error(`Check name is required (at most ${commandLimits.nameCharacters} characters)`);
  if (Object.keys(spec).some(key => !checkOptions.includes(key))) throw new Error('Unknown check option');
  validatePreparation(spec);
  validateCriteria(spec);
  validateCommand(spec);
  const { minTimeoutMs, maxTimeoutMs } = commandLimits;
  if (!Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < minTimeoutMs || spec.timeoutMs > maxTimeoutMs)
    throw new Error(`Check timeout must be between ${minTimeoutMs} and ${maxTimeoutMs} ms`);
  if (
    typeof spec.artifact !== 'string' ||
    typeof spec.instructionsDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(spec.artifact) ||
    !/^[a-f0-9]{64}$/.test(spec.instructionsDigest)
  )
    throw new Error('Copy artifact and instructionsDigest from a current execution snapshot');
}

function validateReuse(spec: CheckSpec): void {
  if (!spec.restore) return;
  restorePolicySchema.parse(spec.restore);
  if (!spec.preparation || spec.preparation.scope || spec.criteria || spec.reuse || spec.readiness)
    throw new Error('Restore reuse requires unscoped prerequisite preparation');
}
