// Owns the desktop server's discovery and graceful shutdown state. Closing a window or plugin worker
// never calls this; only an authenticated explicit stop or the controller's own shutdown does.
import { HttpError } from './errors.js';
import {
  publishDesktopEndpoint,
  retireDesktopEndpoint,
  type DesktopEndpoint,
  type DesktopProfile,
} from './desktop-discovery.js';

/** Lifecycle wrapper keeps native shutdown and foreground signals on the same settlement path. */
export class DesktopService {
  endpoint: DesktopEndpoint | null = null;
  private closing = false;
  private settling: Promise<void> | null = null;

  constructor(
    private readonly profile: DesktopProfile | null,
    private readonly busy: () => boolean,
    private readonly settle: () => Promise<void>,
  ) {}

  /** Publishes only after the server has successfully bound its loopback port. */
  publish(url: string): void {
    if (this.profile) this.endpoint = publishDesktopEndpoint(this.profile, url);
  }

  /** No new action may begin once an explicit shutdown was accepted. */
  assertOpen(): void {
    if (this.closing) throw new HttpError(503, 'The dashboard is closing');
  }

  /** Checks the displayed instance and settlement synchronously before accepting an HTTP stop. */
  prepareClose(instance: string): void {
    if (!this.endpoint || instance !== this.endpoint.instance) throw new HttpError(409, 'Dashboard instance changed');
    this.requireIdle();
    this.closing = true;
  }

  private requireIdle(): void {
    if (this.busy())
      throw new HttpError(409, 'An action is still running; wait for settlement before closing the dashboard');
  }

  /** Waits for server, health and presentation settlement, then retires only this instance's receipt. */
  close(): Promise<void> {
    if (this.settling) return this.settling;
    try {
      this.requireIdle();
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error('Dashboard is not idle'));
    }
    this.closing = true;
    this.settling = this.settle().then(() => {
      if (this.profile && this.endpoint) retireDesktopEndpoint(this.profile, this.endpoint);
    });
    return this.settling;
  }
}
