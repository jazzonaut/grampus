// The Grampus chat skill: the `skills/grampus/SKILL.md` template with this installation's CLI command, so a
// Claude or Codex chat in Orca can start and control tasks. Installing writes only the skill folders.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const skillSource = join(import.meta.dirname, '..', '..', 'skills', 'grampus', 'SKILL.md');

/** The skill text with its `{{grampus}}` placeholder replaced by the command line that runs this CLI. */
export function renderSkill(commandLine: string): string {
  return readFileSync(skillSource, 'utf8').replaceAll('{{grampus}}', commandLine);
}

/** Where agents look for user skills. */
export function skillTargets(): { agent: string; path: string }[] {
  const codexHome = process.env['CODEX_HOME'] ?? join(homedir(), '.codex');
  return [
    { agent: 'claude', path: join(homedir(), '.claude', 'skills', 'grampus', 'SKILL.md') },
    { agent: 'codex', path: join(codexHome, 'skills', 'grampus', 'SKILL.md') },
  ];
}

/** Write the rendered skill for every agent and return the paths written. */
export function installSkill(commandLine: string): string[] {
  const text = renderSkill(commandLine);
  return skillTargets().map(target => {
    mkdirSync(join(target.path, '..'), { recursive: true });
    writeFileSync(target.path, text);
    return target.path;
  });
}
