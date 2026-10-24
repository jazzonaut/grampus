// Retains complete task instructions when an OS command line cannot carry them. Workers read the file.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Keep the same payload for every replay; never silently replace instructions for an existing request. */
export function retainedTaskSpec(runId: string, requestId: string, spec: string): string {
  const directory = join(tmpdir(), 'grampus-task-specs');
  mkdirSync(directory, { recursive: true });
  const identity = createHash('sha256')
    .update(JSON.stringify([runId, requestId]))
    .digest('hex');
  const path = join(directory, `${identity}.txt`);
  try {
    writeFileSync(path, spec, { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    if (readFileSync(path, 'utf8') !== spec)
      throw new Error('Task specification changed for a recorded Orca request.', { cause: error });
  }
  return `TASK SPECIFICATION FILE: ${path}\nRead this entire UTF-8 file before acting. It contains the complete authoritative task instructions, evidence and delivery mandate. Follow it exactly. Do not edit or delete the file. If it cannot be read, report failure; do not guess or proceed with partial instructions.`;
}
