// Windows autocrlf must not consume feature repair rounds or alter explicit attributes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { prepareCheckout } from '../src/git/checkout.js';
import { git, headSha, uncommittedPaths } from '../src/git/git.js';
import { commitAll, createRepository, write } from './helpers/task-fixture.js';

test('fresh checkout uses LF defaults, preserves explicit CRLF, and leaves shared config untouched', async () => {
  const repo = await createRepository();
  write(repo, '.gitattributes', 'windows.cmd text eol=crlf\n');
  write(repo, 'windows.cmd', 'echo hello\n');
  await commitAll(repo, 'Declare explicit line endings');
  await git(repo, ['config', 'core.autocrlf', 'true']);
  await git(repo, ['checkout-index', '--force', '--all']);
  write(repo, 'greet.js', readFileSync(join(repo, 'greet.js'), 'utf8').replaceAll('\n', '\r\n'));
  write(repo, 'windows.cmd', 'echo hello\r\n');
  await git(repo, ['add', '--renormalize', '.']);
  const sha = await headSha(repo);
  assert.match(readFileSync(join(repo, 'greet.js'), 'utf8'), /\r\n/);
  await prepareCheckout(repo);
  assert.doesNotMatch(readFileSync(join(repo, 'greet.js'), 'utf8'), /\r/);
  assert.match(readFileSync(join(repo, 'windows.cmd'), 'utf8'), /\r\n/);
  assert.equal((await git(repo, ['config', 'core.autocrlf'])).trim(), 'true');
  assert.equal(await headSha(repo), sha);
  assert.deepEqual(await uncommittedPaths(repo), []);
  await prepareCheckout(repo);
  write(repo, 'greet.js', 'user edit\n');
  await assert.rejects(prepareCheckout(repo), /clean/);
  assert.equal(readFileSync(join(repo, 'greet.js'), 'utf8'), 'user edit\n');
});
