import type { CommandTimeoutPolicy } from './types.ts';

// Request-envelope constants, relocated from src/daemon/request-timeouts.ts when
// timeout policy joined the descriptor registry (ADR 0008): the envelopes are now
// declared per command on the descriptors, so their values live beside them.

const DAEMON_REQUEST_TIMEOUT_MS = 90_000;
export const PREPARE_REQUEST_TIMEOUT_MS = 240_000;

// Keep this above the longest platform install subprocess timeout so the client
// envelope does not abort a still-progressing device install first.
export const INSTALL_REQUEST_TIMEOUT_MS = 180_000;

/**
 * The timeout policy most commands share: standard envelope, no user-supplied
 * budget, and a daemon reset on timeout (a hung request usually means daemon
 * state is suspect). Referenced explicitly by each descriptor — required, not
 * inherited — so adding a command forces a decision (ADR 0008). Also the
 * fallback for command names outside the registry (internal probes, unknown
 * commands), which matches the old hand lists: not listed meant default
 * envelope + reset-daemon.
 */
export const DEFAULT_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  budget: { source: 'none' },
  envelopeMs: DAEMON_REQUEST_TIMEOUT_MS,
  onTimeout: 'reset-daemon',
};
