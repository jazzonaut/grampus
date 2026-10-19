// Owns the typed errors the journal layer raises, so that callers such as the dashboard server can map
// them to a response (404, 409) by class instead of by message text.

/** A record that was asked for by id does not exist in the journal. */
export class RecordNotFoundError extends Error {
  readonly record: string;
  readonly id: string;
  constructor(record: string, id: string) {
    super(`${record} not found: ${id}`);
    this.name = 'RecordNotFoundError';
    this.record = record;
    this.id = id;
  }
}

/**
 * A decision named a state (a decision key, turn key, version or digest) that is no longer current:
 * the caller acted on a stale view and must refresh. Nothing was changed.
 */
export class StaleStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaleStateError';
  }
}
