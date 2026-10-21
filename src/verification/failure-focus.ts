// Owns conservative browser failure observations and selections within existing approved diagnostics.
import type { RepositoryCheck } from '../persistence/records.js';
import type { GuidedSlice } from '../domain/guided-plan.js';
import type { DiagnosticSelection } from '../domain/diagnostics.js';
import { diagnosticSelectionSchema } from '../domain/diagnostics.js';
import { checkOutputSummary } from './check-output.js';
import { commandLimits } from '../config/limits.js';

/** Failure headings are observations from untrusted output, so paths must still pass the approved grammar. */
function failureCases(text: string) {
  const cases: { file: string; title: string }[] = [];
  for (const line of text.split('\n')) {
    const match =
      /^\s*\d+\)\s+\[[^\]]+\]\s+›\s+(.+?\.(?:spec|test)\.[cm]?[jt]sx?):\d+:\d+\s+›\s+(.+?)(?:\s+─+)?\s*$/.exec(line);
    if (!match?.[1] || !match[2]) continue;
    const file = match[1].replaceAll('\\', '/'),
      title = match[2].trim();
    if (file.startsWith('/') || file.startsWith('-') || file.includes(':') || file.split('/').includes('..')) continue;
    if (!cases.some(item => item.file === file && item.title === title)) cases.push({ file, title });
    if (cases.length > commandLimits.diagnosticFiles) return [];
  }
  return cases;
}

/** Extracts only explicit Playwright failure headings; incomplete or unfamiliar output stays unknown. */
export function browserFailureFocus(check: RepositoryCheck) {
  const text = checkOutputSummary(check),
    cases = failureCases(text);
  const errors = text.split('\n').filter(line => /^\s*(?:Error:|AssertionError:|TimeoutError:)/.test(line));
  const expected = /^\s*(\d+) failed\s*$/m.exec(text)?.[1];
  const complete =
    !check.result?.outputTruncated &&
    !check.result?.outputUnavailable &&
    !!expected &&
    Number(expected) === cases.length;
  const lifecycle = (line: string) =>
    /Error: browserContext\.close: (?:Protocol error \(Target\.disposeBrowserContext\): Failed to find context with id|Test ended\.)/.test(
      line,
    );
  return {
    cases,
    complete,
    environment:
      errors.length > 0 &&
      errors.every(lifecycle) &&
      !/expect\(|AssertionError|TimeoutError/.test(text) &&
      !check.result?.outputTruncated &&
      !check.result?.outputUnavailable,
  };
}

/** Maps observed failures to an approved literal Playwright command; no executable or grammar is invented. */
export function repairDiagnostic(check: RepositoryCheck, diagnostics: GuidedSlice['diagnostics']) {
  const focus = browserFailureFocus(check);
  if (!focus.complete || !focus.cases.length) return null;
  const family = diagnostics.find(
    item =>
      item.args.some(arg => /(?:^|[\\/])(?:@playwright|playwright)(?:[\\/]|$)/.test(arg)) &&
      item.selection.parameters.some(parameter => parameter.flag === '--grep' && !parameter.values) &&
      focus.cases.every(test => item.selection.fileSuffixes.some(suffix => test.file.endsWith(suffix))),
  );
  const parameter = family?.selection.parameters.find(item => item.flag === '--grep' && !item.values);
  if (!family || !parameter) return null;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const selection: DiagnosticSelection = {
    files: [...new Set(focus.cases.map(item => item.file))],
    parameters: { [parameter.name]: `(?:${focus.cases.map(item => escape(item.title)).join('|')})` },
  };
  if (!diagnosticSelectionSchema.safeParse(selection).success) return null;
  return { name: `diagnostic:${family.name}`, selection, cases: focus.cases };
}
