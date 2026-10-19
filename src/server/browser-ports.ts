// Owns which loopback port the dashboard listens on. Browsers, and Node's own fetch, refuse to connect to
// the WHATWG Fetch "bad ports" (https://fetch.spec.whatwg.org/#port-blocking), so a dashboard there would
// be unreachable: an ephemeral port on that list is exchanged for another, and an explicitly requested
// one is refused before listening.
import type { Server } from 'node:http';
import { serverLimits } from '../config/limits.js';

/** The Fetch standard's bad ports. Node's fetch refuses exactly these. */
const badPorts: ReadonlySet<number> = new Set([
  1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532,
  540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061,
  6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

/** True when browsers refuse to connect to `port`. */
export function browserRefusesPort(port: number): boolean {
  return badPorts.has(port);
}

function listen(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const address = server.address();
      if (!address || typeof address === 'string') reject(new Error('Dashboard address unavailable'));
      else resolve(address.port);
    });
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
}

/**
 * Listens on loopback `port` and returns the port in use. With port 0 the system chooses, and a choice
 * browsers refuse is closed and replaced, at most `serverLimits.ephemeralPortAttempts` times.
 *
 * @throws Error before listening when `port` is one browsers refuse, or when every ephemeral port tried
 *   was one; any listen error (such as the port being in use) is passed on.
 */
export async function listenForBrowsers(server: Server, port: number): Promise<number> {
  if (port !== 0 && browserRefusesPort(port))
    throw new Error(`Browsers refuse port ${port}; choose another dashboard port`);
  for (let attempt = 1; ; attempt++) {
    const assigned = await listen(server, port);
    if (!browserRefusesPort(assigned)) return assigned;
    await close(server);
    if (attempt >= serverLimits.ephemeralPortAttempts)
      throw new Error(`The system assigned only ports browsers refuse after ${attempt} attempts`);
  }
}
