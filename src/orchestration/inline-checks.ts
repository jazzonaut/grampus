// Owns compiling, never running, a generated inline Node check exactly the way Node will run it, so a
// planner's script is refused only when Node itself would refuse it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Script } from 'node:vm';
import { processLimits } from '../config/limits.js';

/** The `--input-type` given before the script, or null when Node detects it. */
function inputType(args: readonly string[], evalIndex: number): 'module' | 'commonjs' | null {
  for (let index = 0; index < evalIndex; index++) {
    const arg = args[index] ?? '';
    const value = arg.startsWith('--input-type=')
      ? arg.slice('--input-type='.length)
      : arg === '--input-type'
        ? args[index + 1]
        : undefined;
    if (value === 'module' || value === 'commonjs') return value;
  }
  return null;
}

function scriptError(source: string): Error | null {
  try {
    new Script(source);
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/** Parses `source` as an ES module with `node --check` on a temporary `.mjs` file; nothing runs. */
function moduleError(source: string): Error | null {
  const root = mkdtempSync(join(tmpdir(), 'grampus-inline-check-'));
  try {
    const file = join(root, 'check.mjs');
    writeFileSync(file, source);
    const result = spawnSync(process.execPath, ['--check', file], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: processLimits.inlineCheckSyntaxMs,
    });
    if (result.error) return result.error;
    if (result.status === 0) return null;
    const line = result.stderr
      .split(/\r?\n/)
      .map(text => text.trim())
      .find(text => /^\w*Error:/.test(text));
    return new Error(line ?? `Module syntax check failed with exit ${result.status ?? 'unknown'}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/**
 * Why Node would refuse the script of a `node -e` command, or null when it would compile it (or the
 * command has no inline script). Like Node: `--input-type=module` compiles an ES module,
 * `--input-type=commonjs` CommonJS only, and without either a script that fails as CommonJS is retried
 * as an ES module. A module's own syntax error is reported rather than the CommonJS complaint about it.
 */
export function inlineCheckError(args: readonly string[]): Error | null {
  const evalIndex = args.findIndex(arg => arg === '-e' || arg === '--eval');
  if (evalIndex < 0) return null;
  const source = args[evalIndex + 1] ?? '';
  const type = inputType(args, evalIndex);
  if (type === 'module') return moduleError(source);
  const script = scriptError(source);
  if (!script || type === 'commonjs') return script;
  const module = moduleError(source);
  if (!module) return null;
  return /import|export|await|module/i.test(script.message) ? module : script;
}
