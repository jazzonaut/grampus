// Owns ELK's local worker. The heavy layout engine stays off the UI thread and requires no external service.
import ELK, { type ELK as LayoutEngine } from 'elkjs/lib/elk-api';
import workerUrl from 'elkjs/lib/elk-worker.min.js?url';

/** Creates a worker whose lifetime belongs to its mounted graph. All code is served under the existing CSP. */
export function createLayoutEngine(): LayoutEngine {
  return new ELK({ workerFactory: () => new Worker(workerUrl, { name: 'grampus-layout' }) });
}
