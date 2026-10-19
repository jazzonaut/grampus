// Owns serving the built dashboard client (`web/dist`, produced by `npm --prefix web run build`): the
// page at `/`, the favicon and the hashed bundles under `/assets/`. Nothing else in the folder is served,
// a request path can never leave it, and every file gets an explicit content type. The server's security
// headers (CSP, nosniff, no-store) are set by the caller before this runs.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `web/dist` beside `dist/`, in a development checkout and in an installed snapshot alike. */
export const defaultClientDirectory = fileURLToPath(new URL('../../../web/dist/', import.meta.url));

/** Content types of the files a Vite build emits. Anything else is not served. */
const contentTypes: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** One asset name segment: letters, digits, dot, dash and underscore, never `.` or `..` alone. */
const segment = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

/** A file to send: its bytes and content type. */
export interface ClientFile {
  body: Buffer;
  type: string;
}

/** Shown at `/` when the client has not been built, so a fresh checkout explains itself. */
export const missingClientPage = `<!doctype html>
<html lang="en-GB"><head><meta charset="utf-8"><title>Grampus</title></head>
<body><h1>The dashboard client is not built</h1>
<p>Run <code>npm run build</code> in the Grampus checkout (it builds the server and <code>web/</code>), then reload this page.
The API is running; the link printed by Grampus stays valid.</p></body></html>`;

/** The path inside the client folder that a URL path names, or null when it names nothing servable. */
function clientPath(pathname: string): string | null {
  if (pathname === '/' || pathname === '/index.html') return 'index.html';
  if (pathname === '/favicon.svg') return 'favicon.svg';
  if (!pathname.startsWith('/assets/')) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname.slice('/assets/'.length));
  } catch {
    return null;
  }
  const parts = decoded.split('/');
  return parts.length && parts.every(part => segment.test(part)) ? join('assets', ...parts) : null;
}

/**
 * The client file for a GET path, or null for an unknown path. Resolved paths (after links) must stay
 * inside `directory`; only regular files with a known extension are read.
 */
export function readClientFile(directory: string, pathname: string): ClientFile | null {
  const path = clientPath(pathname);
  if (!path) return null;
  const type = contentTypes[extname(path).toLowerCase()];
  if (!type) return null;
  let root: string, file: string;
  try {
    root = realpathSync.native(directory);
    file = realpathSync.native(resolve(root, path));
    if (!statSync(file).isFile()) return null;
  } catch {
    return null;
  }
  const inside = relative(root, file);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) return null;
  return { body: readFileSync(file), type };
}
