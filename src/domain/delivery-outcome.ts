// Owns the commit represented by verified delivery, including a no-change final slice. A no-change
// result retains its checked HEAD in the request rather than claiming it created a new commit.
import type { Delivery } from '../persistence/records.js';

/** The verified local HEAD, or unknown when a delivery did not settle with sufficient evidence. */
export function verifiedDeliveryHead(delivery: Delivery): string | null {
  if (delivery.phase !== 'delivered') return null;
  if (delivery.outcome === 'committed') return delivery.commit;
  if (delivery.outcome === 'no_change') return delivery.request?.snapshot.head ?? null;
  return null;
}
