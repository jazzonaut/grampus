// `grampus dashboard`: one local HTTP server for the built web app and its JSON API. It listens on every
// interface by default so phones and other machines on the network can use it; see http.ts for the
// guards that keep other web pages from using it through a visitor's browser.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { currentSettings } from '../config/settings.js';
import { OrcaCli } from '../orca/client.js';
import { routes, sendError, type DashboardApp, type DashboardOrca } from './api.js';
import { OrcaProbe } from './health.js';
import { guardHost, guardWrite, HttpError, ownHostNames, sendStatic } from './http.js';
import { TaskReader, TaskWatcher } from './tasks.js';

export interface DashboardOptions {
  dataDir: string;
  port: number;
  /** The command line that runs this CLI, used for driver terminals of tasks started from the dashboard. */
  selfCommand: string;
  /** The built web app; defaults to `dist/web` beside the compiled server. */
  webRoot?: string;
  orca?: DashboardOrca;
}

export interface RunningDashboard {
  port: number;
  /** Addresses to open: localhost first, then this machine's network addresses. */
  urls: string[];
  close(): Promise<void>;
  /** Settles when the server stops. */
  closed: Promise<void>;
}

/** The built web app, two folders up from `dist/src/dashboard`. */
const defaultWebRoot = join(import.meta.dirname, '..', '..', 'web');

export async function serveDashboard(options: DashboardOptions): Promise<RunningDashboard> {
  const settings = currentSettings();
  const orca = options.orca ?? new OrcaCli();
  const app: DashboardApp = {
    dataDir: options.dataDir,
    selfCommand: options.selfCommand,
    reader: new TaskReader(options.dataDir),
    watcher: new TaskWatcher(options.dataDir, settings.waitPollMs),
    orca,
    probe: new OrcaProbe(orca),
  };
  const webRoot = options.webRoot ?? defaultWebRoot;
  const server = createServer((request, response) => {
    void handle(app, webRoot, request, response).catch((error: unknown) => sendError(response, error));
  });
  await listen(server, options.port, settings.dashboardHost);
  const port = (server.address() as AddressInfo).port;
  const closed = new Promise<void>(resolve => server.once('close', () => resolve()));
  return {
    port,
    urls: [`http://localhost:${port}/`, ...lanAddresses().map(address => `http://${address}:${port}/`)],
    closed,
    close: async () => {
      app.watcher.stop();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}

async function handle(
  app: DashboardApp,
  webRoot: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  // Host names are read per request: addresses change when the machine moves between networks.
  guardHost(request, ownHostNames(currentSettings().dashboardAllowedHosts));
  const url = new URL(request.url ?? '/', 'http://dashboard');
  const method = request.method ?? 'GET';
  if (!url.pathname.startsWith('/api/')) {
    if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'Method not allowed.');
    sendStatic(response, webRoot, url.pathname);
    return;
  }
  if (method !== 'GET') guardWrite(request);
  for (const route of routes) {
    const match = route.pattern.exec(url.pathname);
    if (!match || route.method !== method) continue;
    await route.handle({ app, request, response, url, params: match.slice(1) });
    return;
  }
  throw new HttpError(404, 'No such API route.');
}

function listen(server: Server, port: number, host: string | null): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    const ready = () => {
      server.off('error', reject);
      resolve();
    };
    if (host) server.listen(port, host, ready);
    else server.listen(port, ready);
  });
}

/** This machine's IPv4 network addresses, for the URLs printed at startup. */
function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flatMap(addresses => addresses ?? [])
    .filter(address => address.family === 'IPv4' && !address.internal)
    .map(address => address.address);
}
