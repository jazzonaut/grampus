import { connectCodex } from './codex.js';
import { connectClaude } from './claude.js';
import type { Connector } from './types.js';

export const connectAgent: Connector = (provider, options) => provider === 'codex' ? connectCodex(options) : connectClaude(options);
