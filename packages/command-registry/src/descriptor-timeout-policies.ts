import { resolvePostActionObservationSupport } from './post-action-observation.ts';
import { parseTimeout } from './parse-timeout.ts';
import {
  DEFAULT_TIMEOUT_POLICY,
  INSTALL_REQUEST_TIMEOUT_MS,
  INSTALL_SOURCE_DAEMON_DEADLINE_MS,
  INSTALL_SOURCE_REQUEST_TIMEOUT_MS,
  LEASE_ALLOCATE_REQUEST_TIMEOUT_MS,
  MAX_ARMABLE_ALERT_WAIT_WINDOW_MS,
} from './timeout-policy.ts';
import type { CommandTimeoutPolicy } from './types.ts';

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

export const INSTALL_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  envelopeMs: INSTALL_REQUEST_TIMEOUT_MS,
};

/**
 * The one source-install timeout policy shared by `install-from-source` and `install_source`
 * (#4441, decision 6856998913): the 600 s client envelope, with the daemon enforcing the
 * envelope less the result margin (570 s) from admission through the descriptor/router path.
 */
export const INSTALL_SOURCE_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...INSTALL_TIMEOUT_POLICY,
  envelopeMs: INSTALL_SOURCE_REQUEST_TIMEOUT_MS,
  daemonDeadlineMs: INSTALL_SOURCE_DAEMON_DEADLINE_MS,
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

// Settling also captures platform accessibility state, so a hung capture must not
// reset the daemon/session when the client timeout expires.
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

/** The one `alert` subaction whose trailing number is a wait the command polls. */
const ALERT_WAIT_ACTION = 'wait';

/**
 * The `alert` budget travels as the second positional, and what it means depends on the
 * subaction that comes first:
 *
 *  - `alert wait <ms>` is the window the leg polls, so the request envelope has to sit above it
 *    (#4566) — the same shape `wait`'s positional budget has.
 *  - `alert get <ms>` is the Apple runner's read budget, which its owner clamps to 25 s (#4540),
 *    and `accept`/`dismiss` run their own retry window. Neither is a request budget, so neither
 *    widens anything: reading the trailing number without its subaction would turn every
 *    `alert get 120000` into a 150 s envelope the command never uses.
 *
 * A window past {@link MAX_ARMABLE_ALERT_WAIT_WINDOW_MS} resolves to no envelope rather than a
 * shortened one: the alert handler refuses it with its own typed reason before it polls, so the
 * caller never watches a wait end early.
 */
function resolveAlertWaitBudgetMs(positionals: string[]): number | null {
  const action = positionals[0] ?? 'get';
  if (action.toLowerCase() !== ALERT_WAIT_ACTION) return null;
  const windowMs = parseTimeout(positionals[1]);
  if (windowMs === null || windowMs <= 0) return null;
  return windowMs > MAX_ARMABLE_ALERT_WAIT_WINDOW_MS ? null : windowMs;
}

/**
 * `alert` keeps the default envelope for `get`, `accept` and `dismiss`, and widens it past the
 * window only for `wait`. Timeout-on-timeout stays the default's daemon reset: a wait cut off by
 * its envelope is the daemon's own `alert wait` answer, and the read legs never reach it.
 */
export const ALERT_TIMEOUT_POLICY: CommandTimeoutPolicy = {
  ...DEFAULT_TIMEOUT_POLICY,
  budget: { source: 'positional-parser', parser: resolveAlertWaitBudgetMs },
};
