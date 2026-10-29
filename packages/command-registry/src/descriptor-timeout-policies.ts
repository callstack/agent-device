import { resolvePostActionObservationSupport } from './post-action-observation.ts';
import {
  DEFAULT_TIMEOUT_POLICY,
  INSTALL_REQUEST_TIMEOUT_MS,
  LEASE_ALLOCATE_REQUEST_TIMEOUT_MS,
} from './timeout-policy.ts';
import type { CommandTimeoutPolicy } from './types.ts';

// ---------------------------------------------------------------------------
// Timeout policies — descriptor-owned request-envelope budget source and
// on-timeout daemon policy (ADR 0008). This replaces the two deleted client
// hand lists (`isExplicitTimeoutCommand` in daemon-client.ts and
// `DAEMON_PRESERVING_TIMEOUT_COMMANDS` in daemon-client-timeout.ts) plus the
// per-command envelope branches of `resolveDaemonRequestTimeoutMs`.
// ---------------------------------------------------------------------------

// Read-only capture commands that can block in platform accessibility bridges
// while the app is crashed or never idle share snapshot's failure mode. Keep the
// daemon/session alive on their timeouts so callers can still collect
// screenshot/perf/log evidence and close the session after the runner abort
// path has been triggered — resetting the daemon here turned one timed-out wait
// into a lost session for every session the daemon owned.
export const PRESERVE_DAEMON_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  onTimeout: 'preserve-daemon',
};

// Installs run long device subprocesses; their envelope stays above the longest
// platform install subprocess timeout (see INSTALL_REQUEST_TIMEOUT_MS).
export const INSTALL_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  envelopeMs: INSTALL_REQUEST_TIMEOUT_MS,
};

// Lease-route commands act on billed cloud sessions the daemon owns; resetting
// the daemon on a client timeout would SIGKILL it mid-create/mid-release and
// orphan them all (#1774). Allocation also gets an envelope sized for remote
// device allocation (see LEASE_ALLOCATION_BUDGET_MS).
export const LEASE_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  onTimeout: 'preserve-daemon',
};
export const LEASE_ALLOCATE_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...LEASE_TIMEOUT_POLICY,
  envelopeMs: LEASE_ALLOCATE_REQUEST_TIMEOUT_MS,
};

// Settle-capable interaction commands also resolve their target through the
// same platform accessibility capture as snapshot/find (#1105): a hung capture
// is their dominant timeout mode, so on top of the --settle flag-sourced
// widening envelope above, keep the daemon (and sessions) alive on timeout too.
export const SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  // --settle (#1101) makes --timeout bound the SETTLE wait, not the whole
  // request. Widen the envelope by the settle budget so selector/action
  // overhead still has room before the post-action wait.
  budget: {
    source: 'flag',
    envelope: 'widen',
    defaultBudgetMs: 10_000,
  },
  onTimeout: 'preserve-daemon',
};

/**
 * A settle-capable command spends its `--timeout` on the post-action wait, so
 * the envelope has to widen by that budget wherever the trait is declared —
 * interaction route or generic route (#1638). `withoutObservation` is the
 * policy the command would carry if the trait were dropped, so removing a
 * trait restores the command's own envelope instead of silently leaving it on
 * the settle one.
 */
export function postActionObservationTimeoutPolicy(
  command: string,
  withoutObservation: CommandTimeoutPolicy,
): CommandTimeoutPolicy {
  return resolvePostActionObservationSupport(command) !== undefined
    ? SETTLE_FLAG_PRESERVE_DAEMON_TIMEOUT_POLICY
    : withoutObservation;
}
