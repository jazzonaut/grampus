// Owns dashboard origin checks. The receiving socket, rather than an untrusted Host header, identifies
// the interface a LAN request reached, so accepting LAN IPs does not also accept DNS rebinding hosts.
import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.js';

/** Parse a dashboard URL only after checking its host, origin and browser fetch context. */
export function dashboardRequestUrl(request: IncomingMessage, localOrigin: string, listenOnLan: boolean): URL {
  const { host, origin } = new URL(
    listenOnLan ? `http://${request.socket.localAddress}:${request.socket.localPort}` : localOrigin,
  );
  const url = new URL(request.url ?? '/', origin);
  if (
    request.headers.host !== host ||
    url.origin !== origin ||
    (url.pathname.startsWith('/api/') && request.headers['sec-fetch-site'] === 'cross-site') ||
    (request.headers.origin && request.headers.origin !== origin)
  )
    throw new HttpError(403, 'Local origin required');
  return url;
}
