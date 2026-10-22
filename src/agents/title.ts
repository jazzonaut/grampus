// Names a task from its request with a small Claude model, so task ids, worktrees and branches say what
// the task does instead of repeating the request's first words. Naming is a convenience: any failure
// falls back to the request's first line. The call's tokens are not part of the task's measurements.
import { tmpdir } from 'node:os';
import { inputLimits } from '../config/limits.js';
import { currentSettings } from '../config/settings.js';
import { runCommandLine } from '../process/run.js';

const instructions = `Name this coding task for a task list. Reply with the name only: three to seven words in \
sentence case, no quotes, no trailing full stop. Say what changes, not who asks for it.

Request:
`;

/** A short title for `request` from `titleModel`, or null when naming is off or did not work. */
export async function suggestTitle(request: string): Promise<string | null> {
  const { claudeCommand, titleModel, titleTimeoutMs } = currentSettings();
  if (!titleModel) return null;
  try {
    // The request goes on standard input, never on the command line, which cmd.exe would interpret. A
    // neutral folder keeps a repository's agent instructions out of the prompt.
    const result = await runCommandLine(
      claudeCommand,
      ['-p', '--model', titleModel, '--no-session-persistence', '--tools', ''],
      { timeoutMs: titleTimeoutMs, input: `${instructions}${request}`, cwd: tmpdir() },
    );
    return result.exitCode === 0 && !result.timedOut ? cleanTitle(result.stdout) : null;
  } catch {
    return null;
  }
}

/** The model's answer as a title: its first line without a label, quotes, Markdown or full stop. */
export function cleanTitle(answer: string): string | null {
  const line = answer
    .split(/\r?\n/)
    .map(text => text.trim())
    .find(Boolean);
  const title = (line ?? '')
    .replace(/[*_`#]/g, '')
    .replace(/^(title|name):\s*/i, '')
    .replace(/^["'“‘]+|["'”’]+$/g, '')
    .replace(/\.+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title && title.length <= inputLimits.titleLength ? title : null;
}
