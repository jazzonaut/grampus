// HTTP plumbing for the dashboard: JSON responses, bounded bodies, static files and the request guards.
//
// The dashboard has no login: anyone who can reach it may control tasks, which the user chose so it works
// from other devices on the local network. The guards stop other web pages from using the browser of
// someone who can reach it: a request must name one of this machine's own host names (no DNS rebinding),
// a write must come from the dashboard's own origin as JSON (no cross-site forms or fetches), and pages
// may not be framed (no clickjacking).
import { createReadStream, existsSync, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostname, networkInterfaces } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { inputLimits } from '../config/limits.js';

/** An error with the HTTP status it should be answered with. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  // Agent output is rendered as Markdown without raw HTML; this policy is the second line of defence.
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
} as const;

export function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    ...securityHeaders,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

export function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    ...securityHeaders,
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(text);
}

/** Read and parse a JSON request body, refusing anything larger than the input bound. */
export async function readJson(request: IncomingMessage): Promise<unknown> {
  const type = request.headers['content-type'] ?? '';
  if (!type.toLowerCase().startsWith('application/json')) throw new HttpError(415, 'Send JSON.');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request as AsyncIterable<Buffer>) {
    bytes += chunk.length;
    if (bytes > inputLimits.bodyBytes) throw new HttpError(413, 'The request is too large.');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'The request body is not valid JSON.');
  }
}

/** The host names this machine answers to: localhost, its name, its addresses and any configured extras. */
export function ownHostNames(extra: readonly string[]): Set<string> {
  const names = new Set(['localhost', '127.0.0.1', '::1', ...extra.map(name => name.toLowerCase())]);
  const name = hostname().toLowerCase();
  names.add(name);
  names.add(`${name}.local`);
  for (const addresses of Object.values(networkInterfaces()))
    for (const address of addresses ?? []) names.add(address.address.toLowerCase().replace(/%.*$/, ''));
  return names;
}

/** The host name of a `Host` header value, without port or IPv6 brackets. */
export function hostOf(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[')) return trimmed.slice(1, trimmed.indexOf(']'));
  const colon = trimmed.lastIndexOf(':');
  return colon > -1 && trimmed.indexOf(':') === colon ? trimmed.slice(0, colon) : trimmed;
}

/** Refuse requests for a host this machine does not answer to, which is what DNS rebinding relies on. */
export function guardHost(request: IncomingMessage, allowed: Set<string>): void {
  const host = request.headers.host;
  if (!host || !allowed.has(hostOf(host))) throw new HttpError(421, 'Unknown host. Add it to dashboardAllowedHosts.');
}

/** Refuse a write that does not come from a dashboard page on the same origin. */
export function guardWrite(request: IncomingMessage): void {
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (!origin || !host) throw new HttpError(403, 'Writes must come from the dashboard.');
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new HttpError(403, 'Writes must come from the dashboard.');
  }
  if (originHost.toLowerCase() !== host.toLowerCase()) throw new HttpError(403, 'Writes must come from the dashboard.');
}

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * Serve a file of the built web app. Unknown paths get `index.html` so client-side routes load; hashed
 * assets are cached for good, everything else is revalidated.
 */
export function sendStatic(response: ServerResponse, root: string, urlPath: string): void {
  const base = resolve(root);
  const decoded = decodeURIComponent(urlPath.split('?')[0] ?? '/');
  const candidate = resolve(join(base, decoded));
  const inside = candidate === base || candidate.startsWith(base + sep);
  const file = inside && existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(base, 'index.html');
  if (!existsSync(file)) {
    sendText(response, 404, 'The dashboard has not been built. Run `npm run build`.');
    return;
  }
  const immutable = file.includes(`${sep}assets${sep}`);
  response.writeHead(200, {
    ...securityHeaders,
    'Content-Type': contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  createReadStream(file).pipe(response);
}

/** Start a server-sent event stream. */
export function startEvents(response: ServerResponse): (event: string, data: unknown) => void {
  response.writeHead(200, {
    ...securityHeaders,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  return (event, data) => response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}
