// Verification must observe the same tree and approved specification throughout a read-only stage.
import { createHash } from 'node:crypto';
import { git, headSha } from '../git/git.js';
import { hashText } from '../domain/spec.js';
import { DriverStop } from './driver-core.js';
import type { SpecVersion } from './state.js';
import { approvedSpecPath, readWorkerFile } from './workspace-files.js';

/** Capture tracked edits and untracked paths too: a dirty candidate is never silently made clean evidence. */
export async function evidenceSnapshot(worktree: string, sha: string, spec: SpecVersion): Promise<string> {
  if ((await headSha(worktree)) !== sha || hashText(readWorkerFile(approvedSpecPath(worktree)) ?? '') !== spec.hash)
    throw new DriverStop(
      'Verification no longer matches the candidate commit and approved spec. Restore them before resuming.',
    );
  const diff = await git(worktree, ['diff', 'HEAD', '--binary']);
  const status = await git(worktree, ['status', '--porcelain']);
  return createHash('sha256').update(diff).update(status).digest('hex');
}

/** Refuse to attach checks or review to a commit when a supposedly read-only stage changed its inputs. */
export async function assertEvidenceUnchanged(
  worktree: string,
  sha: string,
  spec: SpecVersion,
  before: string,
): Promise<void> {
  if ((await evidenceSnapshot(worktree, sha, spec)) !== before)
    throw new DriverStop('The worktree changed during verification. Restore the candidate before resuming.');
}
