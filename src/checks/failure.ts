// Conservative failure attribution. A failing exit code alone says nothing about behaviour.
import { stripVTControlCharacters } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { currentSettings } from '../config/settings.js';
import type { CheckResult } from '../domain/events.js';

export type CheckOutcome = 'passed' | 'behavioural-failure' | 'incompatible' | 'execution-error' | 'unknown';
export interface CheckAssessment {
  name: string;
  outcome: CheckOutcome;
  reason: string;
}

/** Classify observed output, allowing behavioural attribution only for an established test interface. */
export function assessCheck(result: CheckResult, portable: boolean): CheckAssessment {
  const make = (outcome: CheckOutcome, reason: string): CheckAssessment => ({ name: result.name, outcome, reason });
  if (result.passed) return make('passed', 'The check passed at this commit.');
  if (result.timedOut || result.exitCode === null)
    return make('execution-error', 'The check timed out or could not start.');
  if (!existsSync(result.logPath)) return make('unknown', 'The check log is unavailable.');
  const log = stripVTControlCharacters(readFileSync(result.logPath, 'utf8'));
  const settings = currentSettings();
  if (settings.checkInfrastructurePatterns.some(pattern => new RegExp(pattern, 'i').test(log)))
    return make('execution-error', 'The log reports a missing prerequisite or runner failure.');
  if (settings.crossCheckIncompatiblePatterns.some(pattern => new RegExp(pattern).test(log)))
    return make('incompatible', 'The tests could not use the candidate API.');
  if (portable && settings.checkAssertionPatterns.some(pattern => new RegExp(pattern).test(log)))
    return make('behavioural-failure', 'An assertion failed through the declared stable test interface.');
  return make(
    'unknown',
    portable
      ? 'No recognised behavioural failure evidence.'
      : 'Compatibility with the copied tests is not established.',
  );
}
