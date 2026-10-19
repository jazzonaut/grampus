// Serving the built dashboard client: the page, hashed assets and favicon with explicit content types and
// the unchanged security headers, no path outside the client folder, a clear page while the client is not
// built, and (when web/dist exists) the real build's own asset references.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { startUi } from '../src/server/ui-server.js';
import { defaultClientDirectory } from '../src/server/static-client.js';
import type { OverviewV1 } from '../src/server/api-types.js';

const csp =
  "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

function clientFixture(root: string): string {
  const client = join(root, 'dist');
  mkdirSync(join(client, 'assets'), { recursive: true });
  writeFileSync(
    join(client, 'index.html'),
    '<!doctype html><title>Grampus</title><script type="module" src="./assets/index-abc123.js"></script>',
  );
  writeFileSync(join(client, 'assets', 'index-abc123.js'), 'console.log("client");');
  writeFileSync(join(client, 'assets', 'index-abc123.css'), 'body{}');
  writeFileSync(join(client, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  writeFileSync(join(client, 'notes.txt'), 'not served at the root');
  writeFileSync(join(root, 'secret.txt'), 'outside the client folder');
  return client;
}

async function dashboard(t: { after(fn: () => Promise<void>): void }, client?: string) {
  const root = mkdtempSync(join(tmpdir(), 'grampus-ui-static-'));
  const ui = await startUi({ db: join(root, 'grampus.sqlite'), port: 0, client: client ?? clientFixture(root) });
  t.after(async () => {
    await ui.close();
    rmSync(root, { recursive: true, force: true });
  });
  const url = new URL(ui.url);
  return { ui, origin: url.origin, token: url.hash.slice(1) };
}

/** A raw GET, so paths reach the server exactly as written (fetch would normalise dot segments). */
function rawGet(origin: string, path: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const sent = request(origin + '/', { path }, response => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    sent.on('error', reject);
    sent.end();
  });
}

test('serves the page, hashed assets and favicon under the CSP, then the v1 overview with the token', async t => {
  const { origin, token } = await dashboard(t);
  const page = await fetch(origin + '/');
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
  assert.equal(page.headers.get('content-security-policy'), csp);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.match(await page.text(), /index-abc123\.js/);
  const script = await fetch(origin + '/assets/index-abc123.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8');
  assert.equal(script.headers.get('content-security-policy'), csp);
  assert.equal(
    (await fetch(origin + '/assets/index-abc123.css')).headers.get('content-type'),
    'text/css; charset=utf-8',
  );
  assert.equal((await fetch(origin + '/favicon.svg')).headers.get('content-type'), 'image/svg+xml');
  const overview = await fetch(origin + '/api/v1/overview', { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(overview.status, 200);
  assert.equal(overview.headers.get('content-security-policy'), csp);
  assert.equal(((await overview.json()) as OverviewV1).apiVersion, 1);
});

test('never serves a path outside the assets folder or an unknown file', async t => {
  const { origin } = await dashboard(t);
  for (const path of [
    '/assets/../secret.txt',
    '/assets/%2e%2e/secret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/assets/..%5c..%5csecret.txt',
    '/assets/%00index-abc123.js',
    '/assets/',
    '/assets/missing.js',
    '/notes.txt',
    '/secret.txt',
    '/src/main.ts',
    '/../secret.txt',
  ])
    assert.equal(await rawGet(origin, path), 404, path);
});

test('explains an unbuilt client at / and keeps the API running', async t => {
  const root = mkdtempSync(join(tmpdir(), 'grampus-ui-unbuilt-'));
  t.after(async () => rmSync(root, { recursive: true, force: true }));
  const { origin, token } = await dashboard(t, join(root, 'missing-dist'));
  const page = await fetch(origin + '/');
  assert.equal(page.status, 503);
  assert.match(await page.text(), /npm run build/);
  assert.equal((await fetch(origin + '/assets/index.js')).status, 404);
  assert.equal(
    (await fetch(origin + '/api/v1/overview', { headers: { Authorization: `Bearer ${token}` } })).status,
    200,
  );
});

test(
  'the real web build references only assets the server serves',
  { skip: !existsSync(join(defaultClientDirectory, 'index.html')) && 'web/dist is not built' },
  async t => {
    const { origin } = await dashboard(t, defaultClientDirectory);
    const html = await (await fetch(origin + '/')).text();
    const references = [...html.matchAll(/(?:src|href)="\.?\/?([^"]+)"/g)].map(match => `/${match[1]!}`);
    assert.ok(references.some(path => path.startsWith('/assets/') && path.endsWith('.js')));
    assert.doesNotMatch(html, /<script(?![^>]*src=)/, 'no inline scripts: the CSP forbids them');
    assert.doesNotMatch(html, /<style|style="/, 'no inline styles: the CSP forbids them');
    for (const path of references) {
      const response = await fetch(origin + path);
      assert.equal(response.status, 200, path);
      if (path.endsWith('.js'))
        assert.doesNotMatch(readFileSync(join(defaultClientDirectory, path), 'utf8'), /\beval\(/);
    }
  },
);
