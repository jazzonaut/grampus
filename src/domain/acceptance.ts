import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { RepositorySnapshot } from '../repository/artifacts.js';
import type { CheckProcessResult } from '../process/check-process.js';
import { acceptanceLimits, formatBytes } from '../config/limits.js';

const { textBytes, expectationsBytes } = acceptanceLimits;

export interface AcceptanceExpectations {
  stderr?: string;
  stdoutJson?: unknown;
  files?: { path: string; absent?: true; content?: string; sha256?: string }[];
}

export function validateExpectations(expectedStdout: unknown, expectations: unknown): void {
  if (
    expectedStdout !== undefined &&
    (typeof expectedStdout !== 'string' || Buffer.byteLength(expectedStdout) > textBytes)
  )
    throw new Error(`expectedStdout must be text at most ${formatBytes(textBytes)}`);
  if (expectations !== undefined) {
    if (
      !expectations ||
      typeof expectations !== 'object' ||
      Array.isArray(expectations) ||
      Object.keys(expectations).some(key => !['stderr', 'stdoutJson', 'files'].includes(key)) ||
      Buffer.byteLength(JSON.stringify(expectations)) > expectationsBytes
    )
      throw new Error(`Invalid acceptance expectations (at most ${formatBytes(expectationsBytes)})`);
    const value = expectations as AcceptanceExpectations;
    if (value.stderr !== undefined && (typeof value.stderr !== 'string' || Buffer.byteLength(value.stderr) > textBytes))
      throw new Error(`Expected stderr must be text at most ${formatBytes(textBytes)}`);
    if (value.files !== undefined) {
      if (!Array.isArray(value.files) || !value.files.length || value.files.length > acceptanceLimits.files)
        throw new Error(`Supply 1–${acceptanceLimits.files} file expectations`);
      const paths = new Set<string>();
      for (const file of value.files) {
        if (
          !file ||
          typeof file !== 'object' ||
          Array.isArray(file) ||
          Object.keys(file).some(key => !['path', 'absent', 'content', 'sha256'].includes(key)) ||
          typeof file.path !== 'string' ||
          !file.path ||
          file.path.length > acceptanceLimits.pathCharacters ||
          /[\\:\0]/.test(file.path) ||
          file.path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
        )
          throw new Error('File expectations require repository-relative regular-file paths');
        const key = process.platform === 'win32' ? file.path.toLowerCase() : file.path;
        if (paths.has(key)) throw new Error('Duplicate file expectation');
        paths.add(key);
        if (
          (file.absent !== undefined && file.absent !== true) ||
          (file.absent && (file.content !== undefined || file.sha256 !== undefined)) ||
          (file.content !== undefined &&
            (typeof file.content !== 'string' || Buffer.byteLength(file.content) > textBytes)) ||
          (file.sha256 !== undefined && (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)))
        )
          throw new Error('Invalid file content, hash or absence expectation');
      }
    }
    if (
      expectedStdout === undefined &&
      value.stderr === undefined &&
      value.stdoutJson === undefined &&
      !value.files?.length
    )
      throw new Error('Acceptance requires expectedStdout or at least one expectation');
  } else if (expectedStdout === undefined) throw new Error('Acceptance requires expectedStdout or expectations');
}

/** Compare approved observations with retained output and the verified repository inventory. */
export function assertAcceptance(
  snapshot: RepositorySnapshot,
  result: CheckProcessResult,
  expectedStdout?: string,
  expectations?: AcceptanceExpectations,
): void {
  if (result.outputUnavailable || result.outputTruncated)
    throw new Error('Acceptance output was truncated/unavailable');
  if (expectedStdout !== undefined && result.stdout !== expectedStdout)
    throw new Error('Acceptance output did not exactly match expectedStdout');
  if (expectations?.stderr !== undefined && result.stderr !== expectations.stderr)
    throw new Error('Acceptance stderr did not exactly match its expectation');
  if (expectations?.stdoutJson !== undefined) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new Error('Acceptance stdout is not valid JSON');
    }
    if (!isDeepStrictEqual(parsed, expectations.stdoutJson))
      throw new Error('Acceptance JSON output did not match its expected value');
  }
  for (const file of expectations?.files ?? []) {
    const actual = snapshot.files.find(item => item.path === file.path);
    if (!actual) throw new Error(`Acceptance path is outside the verified snapshot inventory: ${file.path}`);
    if (file.absent ? actual.sha256 !== null : actual.sha256 === null)
      throw new Error(`Acceptance file ${file.path} must be ${file.absent ? 'absent' : 'present'}`);
    if (
      (file.sha256 !== undefined && actual.sha256 !== file.sha256) ||
      (file.content !== undefined && actual.sha256 !== createHash('sha256').update(file.content).digest('hex'))
    )
      throw new Error(`Acceptance file content did not match: ${file.path}`);
  }
}
