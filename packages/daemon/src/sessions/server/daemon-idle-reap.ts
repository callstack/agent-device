import {
  DAEMON_LIFECYCLE_REASONS,
  DAEMON_SHUTTING_DOWN_REASON,
  DAEMON_QUIESCE_COMMAND,
  readDaemonLifecycleFence,
  type DaemonLifecycleCensus,
  type DaemonLifecycleFence,
  type DaemonRuntimeOwnership,
} from '@agent-device/daemon-contracts/daemon-resolution';
import { emitDiagnostic } from '@agent-device/host-kit/diagnostics';
import { timingSafeStringEqual } from '@agent-device/host-kit/transport';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import { AppError, normalizeError } from '@agent-device/kernel/errors';
import type { DaemonInvokeFn, DaemonRequest } from '../../core/daemon-request.ts';
import type { LeaseRegistry } from '../../resources/lease-registry.ts';
import type { SessionStore } from '../../core/session-store.ts';
import type { SessionState } from '../../core/session-state.ts';
import { isUncommittedRepairSession } from '../../core/session-replay-transaction.ts';

// Whether this daemon may leave now, and when it will. Two things live here because they answer one
// question from one census:
//
// - `createDaemonIdleReap` bounds the daemon's own lifetime when nothing is using it. Each
//   AGENT_DEVICE_STATE_DIR spawns a dedicated daemon that otherwise never exits on its own, so
//   short-lived sandboxes (deleted codex/claude worktrees, one-off CLI invocations) leave orphaned
//   daemon processes behind indefinitely - observed accumulating (10+) in production. A stale daemon
//   left running this way also keeps holding its iOS runner lease, which blocks a fresh daemon for the
//   same device (see runner-lease.ts stale-lease takeover).
//
//   The window mirrors the runner idle-stop default. Idle retained runners stop with their daemon:
//   their timer and listener observation cannot survive a handoff. Active eligible runners retain the
//   graceful-shutdown adoption policy.
//
// - `createDaemonLifecycleAdmission` answers `daemon_quiesce` before dispatch, using the same
//   work census as idle reap. Embedded runtimes refuse it; their host owns close().

const DAEMON_IDLE_REAP_DEFAULT_MS = 5 * 60_000;

// AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS overrides the window; 0 disables idle
// reap and restores the pre-existing "runs until killed" behavior.
// A timer exit is something only a detached daemon does: a runtime whose host owns it is ended by
// that host, and one whose owner cannot be proven is treated the same way, because nothing here can
// show the window's owner is nobody.
export function resolveDaemonIdleReapMs(
  env: NodeJS.ProcessEnv,
  ownership: DaemonRuntimeOwnership = 'detached',
): number {
  if (ownership !== 'detached') return 0;
  const raw = env.AGENT_DEVICE_DAEMON_IDLE_TIMEOUT_MS?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return DAEMON_IDLE_REAP_DEFAULT_MS;
}

/**
 * ADR 0012 decision 6, R7 (C5a): true when any open session must block
 * idle-reap. A repair-armed, not-yet-committed session is a bounded-lifetime
 * repair transaction, NOT a session that should pin the daemon forever: it
 * intentionally does NOT block idle-reap, so an actively-driven repair resets
 * the idle timer on every command while an ABANDONED one is reaped after the
 * idle window and leaves a `REPAIR_SESSION_EXPIRED` tombstone
 * (`teardownDaemonSession`) rather than leaking the daemon/lease indefinitely.
 * Every ordinary open session (and a repair that already committed) blocks
 * idle-reap as before.
 */
export function hasReapBlockingOpenSessions(sessionStore: SessionStore): boolean {
  return sessionStore.toArray().some((session) => !isReapableRepairSession(session));
}

function isReapableRepairSession(session: SessionState): boolean {
  return isUncommittedRepairSession(session);
}

// Recording lifecycle is session-scoped (session.screenRecording), so a recording
// only ever exists alongside an open session. Kept as an explicit,
// independently testable guard so a future recording path that outlives its
// session cannot silently lose this protection.
export function hasActiveRecording(sessionStore: SessionStore): boolean {
  return sessionStore.toArray().some((session) => Boolean(session.screenRecording));
}

export function isDaemonIdle(params: {
  sessionStore: SessionStore;
  inFlightRequestCount: number;
}): boolean {
  if (params.inFlightRequestCount > 0) return false;
  // A reapable repair-armed session (C5a) does not block idle-reap, so an
  // abandoned repair is bounded; every other open session still does.
  if (hasReapBlockingOpenSessions(params.sessionStore)) return false;
  return !hasActiveRecording(params.sessionStore);
}

export type DaemonIdleReapController = {
  /**
   * Call whenever daemon activity changes (request start/end, session
   * open/close). Reschedules the pending reap when the daemon is currently
   * idle, or cancels it when it is not.
   */
  noteActivity: () => void;
  cancel: () => void;
  readonly idleMs: number;
};

export function createDaemonIdleReap(params: {
  sessionStore: SessionStore;
  getInFlightRequestCount: () => number;
  /**
   * An unexpired `retainOnClose` lease is a caller's claim on this daemon beyond its sessions, so a
   * reap that finds one waits another idle window. The check must also expire leases past their
   * window, or none would ever end.
   */
  hasRetainedLeases: () => boolean;
  onIdleReap: () => void;
  env: NodeJS.ProcessEnv;
  /**
   * Who owns the process this timer runs in. A host that started the runtime in its own process owns
   * its lifetime: an idle window tuned for a detached daemon nobody is watching would take the runtime
   * out from under that owner, so an embedded runtime is never reaped on a timer. Defaults to a
   * detached daemon.
   */
  ownership?: DaemonRuntimeOwnership;
}): DaemonIdleReapController {
  const idleMs = resolveDaemonIdleReapMs(params.env, params.ownership);
  let timer: NodeJS.Timeout | undefined;

  const isIdleNow = (): boolean =>
    isDaemonIdle({
      sessionStore: params.sessionStore,
      inFlightRequestCount: params.getInFlightRequestCount(),
    });

  const cancel = (): void => {
    if (!timer) return;
    clearTimeout(timer);
    timer = undefined;
  };

  const schedule = (): void => {
    cancel();
    if (idleMs <= 0) return;
    timer = setTimeout(() => {
      timer = undefined;
      // Re-check at fire time instead of trusting the scheduling snapshot: a
      // session open or new request must never lose a race against a
      // previously scheduled reap.
      if (!isIdleNow()) return;
      if (params.hasRetainedLeases()) {
        schedule();
        return;
      }
      emitDiagnostic({ level: 'info', phase: 'daemon_idle_reap', data: { idleMs } });
      params.onIdleReap();
    }, idleMs);
    timer.unref?.();
  };

  const noteActivity = (): void => {
    if (isIdleNow()) schedule();
    else cancel();
  };

  return { noteActivity, cancel, idleMs };
}

/**
 * ADR 0006: a detached daemon accepts replacement only while idle.
 * Admission and the work census change in one synchronous step to avoid racing new work.
 * Embedded runtimes refuse replacement because their host owns close().
 */
export type DaemonLifecycleAdmission = Readonly<{
  /**
   * Puts the lifecycle request and the closed admission it leaves behind in front of `handler`: a
   * lifecycle request gets its verdict, and any other request gets the shutting-down refusal once a
   * lifecycle request has closed admission.
   */
  admit(handler: DaemonInvokeFn): DaemonInvokeFn;
}>;

export function daemonShuttingDownResponse(): DaemonResponse {
  return {
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      message: 'Daemon is shutting down.',
      details: { reason: DAEMON_SHUTTING_DOWN_REASON },
    },
  };
}

export function createDaemonLifecycleAdmission(params: {
  token: string;
  identity: DaemonLifecycleFence;
  sessionStore: Pick<SessionStore, 'toArray'>;
  leaseRegistry: Pick<LeaseRegistry, 'listActiveLeases'>;
  /** Requests being served, not counting the lifecycle request itself. */
  inFlightRequestCount: () => number;
  /** Whether the daemon has yet to build the drain path `drain` runs. */
  startingUp: () => boolean;
  /** Starts the drain once, after sending the response. */
  drain: () => void;
  /** Who owns this process and may close it. */
  ownership: () => DaemonRuntimeOwnership;
}): DaemonLifecycleAdmission {
  let admitting = true;
  const refuse = (error: AppError): DaemonResponse => ({
    ok: false,
    error: normalizeError(error),
  });

  const leave = (req: DaemonRequest): DaemonResponse => {
    if (typeof req.token !== 'string' || !timingSafeStringEqual(req.token, params.token)) {
      return refuse(new AppError('UNAUTHORIZED', 'Invalid daemon token.'));
    }
    // A remote client reaches this daemon through the proxy with the shared token, and only the
    // host that owns the state directory may retire the daemon on it.
    if (req.internal?.publicNetworkOnly) {
      return refuse(
        new AppError('UNAUTHORIZED', 'Daemon quiesce is not available to remote clients.'),
      );
    }
    const fence = readDaemonLifecycleFence(req.input);
    // A pid alone can name a recycled process, so a daemon that cannot prove its start time
    // cannot be addressed at all.
    if (!fence || fence.pid !== params.identity.pid) return refuse(instanceMismatch());
    if (params.identity.processStartTime === null) return refuse(instanceMismatch());
    if (fence.processStartTime !== params.identity.processStartTime) {
      return refuse(instanceMismatch());
    }
    if (params.ownership() === 'embedded') return refuse(ownerEmbedded());
    // Admission closes and the census is read in the same synchronous step, so no request can be
    // admitted between the two; a refusal reopens admission in that same step.
    if (!admitting) return { ok: true, data: { outcome: 'draining' } };
    admitting = false;
    const census = readCensus();
    const held = isHeld(census);
    if (held) {
      admitting = true;
      return refuse(busy(census));
    }
    setImmediate(() => params.drain());
    return { ok: true, data: { outcome: 'draining' } };
  };

  const readCensus = (): DaemonLifecycleCensus => {
    const sessions = params.sessionStore.toArray();
    const repairSessions = sessions.filter(isUncommittedRepairSession).length;
    return {
      startingUp: params.startingUp(),
      inFlightRequests: params.inFlightRequestCount(),
      sessions: sessions.length - repairSessions,
      repairSessions,
      leases: params.leaseRegistry.listActiveLeases().length,
    };
  };

  return {
    admit: (handler) => async (req) => {
      if (req.command === DAEMON_QUIESCE_COMMAND) return leave(req);
      return admitting ? await handler(req) : daemonShuttingDownResponse();
    },
  };
}

function isHeld(census: DaemonLifecycleCensus): boolean {
  return (
    census.startingUp ||
    census.inFlightRequests > 0 ||
    census.sessions > 0 ||
    census.repairSessions > 0 ||
    census.leases > 0
  );
}

function busy(census: DaemonLifecycleCensus): AppError {
  return new AppError('COMMAND_FAILED', 'Daemon is busy and was not asked to leave.', {
    reason: DAEMON_LIFECYCLE_REASONS.busy,
    ...census,
  });
}

function instanceMismatch(): AppError {
  return new AppError('COMMAND_FAILED', 'A lifecycle request names a different daemon instance.', {
    reason: DAEMON_LIFECYCLE_REASONS.instanceMismatch,
  });
}

function ownerEmbedded(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'A host process owns this daemon, so only that host can retire it.',
    { reason: DAEMON_LIFECYCLE_REASONS.ownerEmbedded },
  );
}
