// Owns start-or-reconnect for a local desktop dashboard. SQLite supplies a crash-released startup
// mutex, not workflow state. A child may bind the server only after its PID receipt is durable.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { currentSettings } from '../config/settings.js';
import { processAlive } from '../verification/check-recovery.js';
import {
  desktopFiles,
  desktopResponds,
  publishDesktopEndpoint,
  readDesktopEndpoint,
  type DesktopEndpoint,
  type DesktopProfile,
} from './desktop-discovery.js';

const readyMessage = z.strictObject({ type: z.literal('desktop-awaiting-permit') });
const permitMessage = z.strictObject({ type: z.literal('desktop-permit') });
const launches = new Map<string, Promise<{ endpoint: DesktopEndpoint; started: boolean }>>();

/** Startup inputs; tests use a real isolated child server rather than a provider or developer journal. */
export interface DesktopLaunchOptions {
  profile: DesktopProfile;
  port: number;
  entry?: string;
  cwd?: string;
}

/** A background child waits for its durable startup reservation before opening a journal or server. */
export async function awaitDesktopPermit(): Promise<void> {
  if (!process.send) throw new Error('Start the background dashboard with grampus open');
  await new Promise<void>((resolve, reject) => {
    const disconnected = () => reject(new Error('Dashboard launcher exited before startup was permitted'));
    process.once('disconnect', disconnected);
    process.once('message', (message: unknown) => {
      process.off('disconnect', disconnected);
      if (!permitMessage.safeParse(message).success) {
        reject(new Error('Invalid dashboard startup permit'));
        return;
      }
      process.disconnect();
      resolve();
    });
    process.send?.({ type: 'desktop-awaiting-permit' });
  });
}

/** A healthy matching instance is reusable. Live or uncertain owners always prevent another start. */
async function existing(profile: DesktopProfile): Promise<DesktopEndpoint | null> {
  const endpoint = readDesktopEndpoint(profile);
  if (!endpoint) return null;
  if (await desktopResponds(endpoint)) return endpoint;
  if (processAlive(endpoint.pid, endpoint.startedAt))
    throw new Error(
      'Grampus is starting, unavailable or still running. Its process was not restarted. Try again shortly.',
    );
  return null;
}

async function start(options: DesktopLaunchOptions) {
  const { profile } = options;
  const paths = desktopFiles(profile);
  mkdirSync(dirname(paths.lock), { recursive: true });
  // No records live here: BEGIN IMMEDIATE is solely an inter-process mutex. SQLite releases it on
  // crash; same-process callers are coalesced below so a sync busy wait cannot block their own launch.
  const lock = new DatabaseSync(paths.lock);
  lock.exec(`PRAGMA busy_timeout = ${currentSettings().dashboardStartupMs}`);
  try {
    lock.exec('BEGIN IMMEDIATE');
    const found = await existing(profile);
    if (found) return { endpoint: found, started: false };
    return await spawnDashboard(options);
  } finally {
    if (lock.isTransaction) lock.exec('ROLLBACK');
    lock.close();
  }
}

async function spawnDashboard({ profile, port, entry, cwd }: DesktopLaunchOptions) {
  const paths = desktopFiles(profile);
  const log = openSync(paths.log, 'w', 0o600);
  const child = (() => {
    try {
      return spawn(
        process.execPath,
        [
          entry ?? fileURLToPath(new URL('../cli.js', import.meta.url)),
          'ui',
          '--background',
          '--no-open',
          '--db',
          profile.db,
          '--port',
          String(port),
        ],
        {
          cwd: cwd ?? process.cwd(),
          detached: true,
          windowsHide: true,
          stdio: ['ignore', log, log, 'ipc'],
        },
      );
    } finally {
      closeSync(log);
    }
  })();
  let failed = false;
  child.once('error', () => {
    failed = true;
  });
  child.once('exit', () => {
    failed = true;
  });
  child.once('message', (message: unknown) => {
    try {
      if (!child.pid || !readyMessage.safeParse(message).success) throw new Error('Invalid readiness receipt');
      publishDesktopEndpoint(profile, null, child.pid);
      child.send({ type: 'desktop-permit' }, error => {
        if (error) failed = true;
      });
    } catch {
      failed = true;
      if (child.connected) child.disconnect();
    }
  });
  child.unref();
  try {
    const deadline = Date.now() + currentSettings().dashboardStartupMs;
    while (!failed && Date.now() < deadline) {
      const endpoint = readDesktopEndpoint(profile);
      if (endpoint && endpoint.pid === child.pid && (await desktopResponds(endpoint)))
        return { endpoint, started: true };
      await new Promise(resolve => setTimeout(resolve, currentSettings().dashboardPollMs));
    }
    throw new Error(
      `Dashboard startup is ${failed ? 'unsuccessful' : 'unconfirmed'}. Inspect ${paths.log}. No process was stopped or replayed.`,
    );
  } finally {
    if (child.connected) child.disconnect();
  }
}

/** Starts at most one dashboard for a profile, or authenticates and reuses the running instance. */
export function ensureDesktop(options: DesktopLaunchOptions) {
  const key = desktopFiles(options.profile).lock;
  let active = launches.get(key);
  if (!active) {
    active = start(options).finally(() => {
      launches.delete(key);
    });
    launches.set(key, active);
  }
  return active;
}
