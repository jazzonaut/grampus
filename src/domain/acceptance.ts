// Owns acceptance expectations: validating what an approved acceptance command must observe, and
// comparing a settled check's retained output and verified snapshot against it. It never runs the
// command and never trusts an agent's account of the result.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { RepositorySnapshot } from '../repository/artifacts.js';
import type { CheckProcessResult } from '../process/check-process.js';
import { acceptanceLimits, formatBytes } from '../config/limits.js';

const { textBytes, expectationsBytes } = acceptanceLimits;

/**
 * One file the acceptance check expects: present (optionally with exact `content`, `sha256` or both,
 * each of which must match), or `absent`. Checked against the verified snapshot inventory, not the live working tree.
 */
export interface FileExpectation {
  path: string;
  absent?: true;
  content?: string;
  sha256?: string;
}

/**
 * Observations an acceptance command must produce beyond (or instead of) an exact stdout. They are
 * part of the approved plan, so the comparison is fixed before any agent runs.
 */
export interface AcceptanceExpectations {
  stderr?: string;
  stdoutJson?: unknown;
  files?: FileExpectation[];
}

/** A plain object whose keys are all in `allowed`. */
function plainObjectWith(value: unknown, allowed: readonly string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every(key => allowed.includes(key))
  );
}

const boundedText = (value: unknown): boolean => typeof value === 'string' && Buffer.byteLength(value) <= textBytes;

/**
 * A repository-relative regular-file path: forward slashes, no drive or stream separator, no empty,
 * `.` or `..` segment and nothing inside `.git`, so an expectation can never name a file outside the
 * verified snapshot inventory.
 */
function repositoryFilePath(path: unknown): path is string {
  return (
    typeof path === 'string' &&
    path.length > 0 &&
    path.length <= acceptanceLimits.pathCharacters &&
    !/[\\:\0]/.test(path) &&
    !path.split('/').some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
  );
}

/** Whether the content, digest and absence fields of a file expectation are consistent and bounded. */
function consistentFileExpectation(file: Record<string, unknown>): boolean {
  if (file['absent'] !== undefined && file['absent'] !== true) return false;
  if (file['absent'] && (file['content'] !== undefined || file['sha256'] !== undefined)) return false;
  if (file['content'] !== undefined && !boundedText(file['content'])) return false;
  return file['sha256'] === undefined || (typeof file['sha256'] === 'string' && /^[a-f0-9]{64}$/.test(file['sha256']));
}

/** Validates the `files` list; paths are unique case-insensitively on Windows, where they would collide. */
function validateFileExpectations(files: unknown): void {
  if (!Array.isArray(files) || !files.length || files.length > acceptanceLimits.files)
    throw new Error(`Supply 1–${acceptanceLimits.files} file expectations`);
  const paths = new Set<string>();
  const list: unknown[] = files;
  const invalidPath = 'File expectations require repository-relative regular-file paths';
  for (const file of list) {
    if (!plainObjectWith(file, ['path', 'absent', 'content', 'sha256'])) throw new Error(invalidPath);
    const path = file['path'];
    if (!repositoryFilePath(path)) throw new Error(invalidPath);
    const key = process.platform === 'win32' ? path.toLowerCase() : path;
    if (paths.has(key)) throw new Error('Duplicate file expectation');
    paths.add(key);
    if (!consistentFileExpectation(file)) throw new Error('Invalid file content, hash or absence expectation');
  }
}

/** Validates an `expectations` object that is present; `expectedStdout` decides whether it may be empty. */
function validateExpectationFields(expectedStdout: unknown, expectations: unknown): void {
  if (
    !plainObjectWith(expectations, ['stderr', 'stdoutJson', 'files']) ||
    Buffer.byteLength(JSON.stringify(expectations)) > expectationsBytes
  )
    throw new Error(`Invalid acceptance expectations (at most ${formatBytes(expectationsBytes)})`);
  if (expectations['stderr'] !== undefined && !boundedText(expectations['stderr']))
    throw new Error(`Expected stderr must be text at most ${formatBytes(textBytes)}`);
  if (expectations['files'] !== undefined) validateFileExpectations(expectations['files']);
  const files = expectations['files'];
  if (
    expectedStdout === undefined &&
    expectations['stderr'] === undefined &&
    expectations['stdoutJson'] === undefined &&
    !(Array.isArray(files) && files.length)
  )
    throw new Error('Acceptance requires expectedStdout or at least one expectation');
}

/**
 * Validates an acceptance command's observations before approval. Acceptance must observe something:
 * an exact stdout or at least one expectation, because a command whose exit code alone decides
 * acceptance would let an agent-written check pass vacuously. Throws a message naming the first problem.
 */
export function validateExpectations(expectedStdout: unknown, expectations: unknown): void {
  if (expectedStdout !== undefined && !boundedText(expectedStdout))
    throw new Error(`expectedStdout must be text at most ${formatBytes(textBytes)}`);
  if (expectations !== undefined) validateExpectationFields(expectedStdout, expectations);
  else if (expectedStdout === undefined) throw new Error('Acceptance requires expectedStdout or expectations');
}

/**
 * Stored acceptance expectations (in a plan or a check spec). The rules are those of
 * {@link validateExpectations}, applied as if no `expectedStdout` were given, so a stored value must
 * also be nonempty on its own.
 */
export const acceptanceExpectationsSchema = z.custom<AcceptanceExpectations>(value => {
  try {
    validateExpectations(undefined, value);
    return value !== undefined;
  } catch {
    return false;
  }
}, 'Invalid acceptance expectations');

/**
 * Compares approved observations with a settled check's retained output and the verified repository
 * inventory. Truncated or unavailable output never passes, because a partial stream cannot prove an
 * exact match. Throws on the first mismatch; returns only when every observation holds.
 */
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
  if (expectations?.stdoutJson !== undefined) assertJsonOutput(result.stdout, expectations.stdoutJson);
  for (const file of expectations?.files ?? []) assertFile(snapshot, file);
}

function assertJsonOutput(stdout: string, expected: unknown): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('Acceptance stdout is not valid JSON');
  }
  if (!isDeepStrictEqual(parsed, expected)) throw new Error('Acceptance JSON output did not match its expected value');
}

/** Checks one file against the snapshot inventory, where a null digest records an absent path. */
function assertFile(snapshot: RepositorySnapshot, file: FileExpectation): void {
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
