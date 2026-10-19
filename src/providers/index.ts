// Owns the choice of provider adapter for a connection. It adds no policy of its own: each adapter
// enforces authentication, tool authorization and process ownership itself.
import { connectCodex } from './codex.js';
import { connectClaude } from './claude.js';
import type { Connector } from './types.js';

/** The production `Connector`: Codex through `codex app-server`, Claude through the pinned Agent SDK. */
export const connectAgent: Connector = (provider, options) =>
  provider === 'codex' ? connectCodex(options) : connectClaude(options);
