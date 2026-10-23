// Conservative failure attribution. A failing exit code alone says nothing about behaviour.
import { stripVTControlCharacters } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { currentSettings } from '../config/settings.js';
import type { CheckResult } from '../domain/events.js';
import { checkLimits } from '../config/limits.js';

/** Observed named assertion, independent of the command's infrastructure or compatibility verdict. */
export interface CheckAssertion {
  test: string;
  detail: string;
  outcome: 'behavioural-failure' | 'unknown';
}

export type CheckOutcome = 'passed' | 'behavioural-failure' | 'incompatible' | 'execution-error' | 'unknown';
export interface CheckAssessment {
  name: string;
  outcome: CheckOutcome;
  reason: string;
  assertions?: CheckAssertion[];
}

/** Classify observed output, allowing behavioural attribution only for an established test interface. */
export function assessCheck(result: CheckResult, portable: boolean): CheckAssessment {
  const log = existsSync(result.logPath) ? stripVTControlCharacters(readFileSync(result.logPath, 'utf8')) : '';
  const assertions = namedAssertions(log, portable);
  const make = (outcome: CheckOutcome, reason: string): CheckAssessment => ({
    name: result.name,
    outcome,
    reason,
    assertions,
  });
  if (result.passed) return make('passed', 'The check passed at this commit.');
  if (result.timedOut || result.exitCode === null)
    return make('execution-error', 'The check timed out or could not start.');
  if (!existsSync(result.logPath)) return make('unknown', 'The check log is unavailable.');
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

/** Only named failure sections count; a runner footer cannot erase an assertion that actually ran. */
function namedAssertions(log: string, portable: boolean): CheckAssertion[] {
  const markers = [...log.matchAll(/^\s*(?:FAIL\s+|PASS\s+|not ok \d+ - |ok \d+ - |●\s+)[^\n]*/gm)];
  const patterns = currentSettings().checkAssertionPatterns.map(pattern => new RegExp(pattern));
  return markers
    .flatMap((marker, index): CheckAssertion[] => {
      const title = marker[0].trim();
      if (/^(?:PASS|ok )/.test(title)) return [];
      const block = log.slice(marker.index + marker[0].length, markers[index + 1]?.index ?? log.length);
      const detail = block.split(/\r?\n/).find(line => patterns.some(pattern => pattern.test(line)));
      if (!detail) return [];
      return [
        {
          test: title.replace(/^(?:FAIL\s+|not ok \d+ - |●\s+)/, '').slice(0, checkLimits.assertionTextLength),
          detail: detail.trim().slice(0, checkLimits.assertionTextLength),
          outcome: portable ? 'behavioural-failure' : 'unknown',
        },
      ];
    })
    .slice(0, checkLimits.assertions);
}
