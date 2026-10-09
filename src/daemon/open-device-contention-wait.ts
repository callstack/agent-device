import { getFlagDefinitionsForKey } from '@agent-device/command-registry/flag-registry';
import { readOptionalInteger } from '@agent-device/contracts/command';
import { emitRequestProgress, throwIfRequestCanceled } from '@agent-device/host-kit/request';
import { Deadline, sleep } from '@agent-device/host-kit/retry';
import { AppError } from '@agent-device/kernel/errors';
import type { DaemonRequest } from './daemon-request.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionRef, SessionState } from './session-state.ts';
import type { DeviceClaimApp } from './device/device-claim-record.ts';
import { parseMacOsAppLeaseKey } from './macos-app-lease.ts';
import type { DeviceLease } from '@agent-device/contracts/device';
import type { SessionRecoveryOptions } from './session-recovery-hints.ts';

/**
 * How often a waiting open re-checks its device. Contention ends when another session closes or
 * its owner dies, both of which are host-side changes on an agent timescale; a faster poll would
 * only add reads.
 */
const DEVICE_CONTENTION_POLL_MS = 250;

/**
 * The `--wait <ms>` budget an open carries, or `undefined` when it must not block.
 *
 * The bounds are the option's own declaration. The CLI parser refuses a value outside them and so
 * does the tool input derived from it, but a budget built by the Node client or posted straight to
 * the wire has no other reader standing between it and a device, so this reader checks the
 * declaration instead of trusting whichever surface assembled the request.
 */
export function readOpenWaitBudgetMs(req: DaemonRequest): number | undefined {
  const flags = (req.flags ?? {}) as Record<string, unknown>;
  if (flags.waitMs === undefined) return undefined;
  const [declaration] = getFlagDefinitionsForKey('waitMs');
  if (!declaration) {
    throw new AppError(
      'INTERNAL_ERROR',
      'The waitMs option has no flag declaration whose bounds the daemon can enforce.',
    );
  }
  return readOptionalInteger(flags, 'waitMs', {
    min: declaration.min,
    max: declaration.max,
  });
}

/**
 * What this request's `--wait` budget actually spent, for the refusal that ends it.
 *
 * The spend rides on `internal`, which the transport strips, so only the daemon that waited can
 * report a wait and the recovery text can say the budget was spent without a client claiming one
 * that never happened. It is recorded only when a budget ran out with a holder still on the
 * device, which is the one story a refusal can tell honestly.
 */
export function readOpenWaitAttempt(req: DaemonRequest): SessionRecoveryOptions {
  const waitedMs = req.internal?.openDeviceWait?.waitedMs;
  return waitedMs ? { waitedMs } : {};
}

/**
 * What a `DEVICE_IN_USE` refusal may say about `--wait`, for the command that owns it. The spend
 * rides along when there was one, and the flag itself is offered only to a caller that did not
 * already arrive with it: an open that came with a budget is not helped by being told to run the
 * same open with the flag it used, and an interaction has no budget to offer in the first place.
 */
export function describeOpenWaitForRefusal(req: DaemonRequest): SessionRecoveryOptions {
  return {
    ...readOpenWaitAttempt(req),
    offersDeviceWait: req.command === 'open' && typeof req.flags?.waitMs !== 'number',
  };
}

export type OpenDeviceWait = {
  /**
   * Spend what is left of the budget waiting for the session that holds the device to let go.
   *
   * The caller must not hold this request's execution locks here, which is the whole point of the
   * arrangement: the operations that could free a contended device — `close`, `record stop`, the
   * holder's own commands — need that same device lock, so an open that waited while holding it
   * would block the only things that could end its wait.
   *
   * Only another session's claim on the device is waited for. A host-global device claim held by
   * another workspace's daemon is not: that refusal names an operator command rather than a
   * retry, and a budget spent on it buys nothing.
   */
  waitForDeviceOutsideLocks(): Promise<void>;
  /**
   * Run the open inside `acquireLocks`, and hand those locks back when another session took the
   * device in the window between the last look and the lock.
   *
   * The look inside `acquireLocks` is what closes that window: an open can only put its session on
   * a device by writing the session store, and it writes that store while holding the same device
   * lock this request holds. So either nobody holds the device for as long as `task` runs, or
   * this open gives the device back and spends the rest of its budget waiting again — which is
   * what lets several callers queue on one device instead of all but the fastest refusing early.
   *
   * Which sessions conflict depends on the claim the open would take, which it resolves only under
   * the locks. When it reports a conflict through `reportOpenDeviceConflict` the first time, or
   * while budget is left, the refusal `task` returns is dropped and the open waits again.
   */
  runWhenDeviceIsUnheld<T>(params: {
    acquireLocks: <TaskResult>(task: () => Promise<TaskResult>) => Promise<TaskResult>;
    task: () => Promise<T>;
  }): Promise<T>;
};

/**
 * The `--wait <ms>` discipline for this request, or `undefined` when nothing about it may block.
 * Only a fresh open carries one: an open onto a session that already exists is bound to a device
 * nobody else is being refused for, and a request that did not ask to wait is answered at once.
 *
 * `deviceId` is the device the request's own execution-lock plan reserves, so the wait and the
 * lock agree on which device is being waited for without resolving a target a second time.
 * `budgetMs` must already have been read through {@link readOpenWaitBudgetMs}, allowing the request
 * scope to reject an out-of-range budget before resolving that device.
 */
export function beginOpenDeviceWait(params: {
  req: DaemonRequest;
  budgetMs: number | undefined;
  sessionName: string;
  sessionStore: SessionStore;
  deviceId: string | undefined;
}): OpenDeviceWait | undefined {
  const { req, budgetMs, sessionName, sessionStore, deviceId } = params;
  if (req.command !== 'open' || budgetMs === undefined) return undefined;
  if (deviceId === undefined || sessionStore.get(sessionName)) return undefined;
  return createOpenDeviceWait({ req, sessionName, sessionStore, deviceId, budgetMs });
}

/**
 * The other session standing between this open and `deviceId`, or `undefined` when there is none,
 * including when this open's own session is what holds the device. Until the open has resolved the
 * claim it would take, only a session holding the whole device is certain to conflict with it.
 */
function findSessionHoldingDevice(params: {
  sessionStore: SessionStore;
  deviceId: string;
  sessionName: string;
  opener: { app: DeviceClaimApp | undefined } | undefined;
}): SessionRef | undefined {
  const { sessionStore, deviceId, sessionName, opener } = params;
  return sessionStore
    .listRefs()
    .find(
      (ref) =>
        ref.session.device.id === deviceId &&
        ref.address !== sessionName &&
        (opener
          ? sessionConflictsWithOpen(ref.session, opener.app)
          : sessionHeldApp(ref.session) === undefined),
    );
}

type LockedAttempt<Outcome> = { ran: true; outcome: Outcome } | { ran: false };

function createOpenDeviceWait(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  deviceId: string;
  budgetMs: number;
}): OpenDeviceWait {
  const { req, sessionName, sessionStore, deviceId, budgetMs } = params;
  const deadline = Deadline.fromTimeoutMs(budgetMs);
  let opener: { app: DeviceClaimApp | undefined } | undefined;
  let openDeferred = false;
  const holder = () => findSessionHoldingDevice({ sessionStore, deviceId, sessionName, opener });
  const internal = (req.internal ??= {});
  const spend = (internal.openDeviceWait ??= { waitedMs: 0 });
  internal.reportOpenDeviceConflict = (openerApp) => {
    const firstLook = opener === undefined;
    opener = { app: openerApp };
    openDeferred = firstLook || !deadline.isExpired();
  };

  const waitForDeviceOutsideLocks = async (): Promise<void> => {
    for (;;) {
      const holding = holder();
      // Either nobody is on the device and this open goes looking for it under the locks, or the
      // budget is gone and the locks are where the refusal gets its say. Both end the wait.
      if (!holding || deadline.isExpired()) return;
      emitRequestProgress({
        type: 'command',
        status: 'progress',
        message: `Waiting for ${holding.session.device.name}: held by session "${holding.address}" (${Math.round(
          deadline.elapsedMs(),
        )}ms of the ${Math.round(budgetMs)}ms wait budget used)`,
      });
      await sleep(Math.min(DEVICE_CONTENTION_POLL_MS, deadline.remainingMs()));
      // A client that gave up on the request must not leave the daemon queueing for a device
      // nobody wants any more. Checked after the poll rather than before the first look because
      // whether an already-canceled request runs at all is the request pipeline's own question.
      throwIfRequestCanceled(req.meta?.requestId);
    }
  };

  return {
    waitForDeviceOutsideLocks,
    runWhenDeviceIsUnheld: async <TaskResult>(params: {
      acquireLocks: <Inner>(task: () => Promise<Inner>) => Promise<Inner>;
      task: () => Promise<TaskResult>;
    }): Promise<TaskResult> => {
      const { acquireLocks, task } = params;
      for (;;) {
        const attempt = await acquireLocks<LockedAttempt<TaskResult>>(async () => {
          if (holder()) {
            if (!deadline.isExpired()) return { ran: false };
            // The refusal this open is about to get can say the budget was spent, because under
            // these locks it is: nobody else can hand the device over any more.
            spend.waitedMs = Math.max(0, deadline.elapsedMs());
          }
          openDeferred = false;
          const outcome = await task();
          return openDeferred ? { ran: false } : { ran: true, outcome };
        });
        if (attempt.ran) return attempt.outcome;
        // The device was taken after the look that let this open reach the locks. Leaving them
        // go is what keeps the session that took it able to close and hand the device back.
        await waitForDeviceOutsideLocks();
      }
    },
  };
}

/**
 * The one app a session drives on its device, or `undefined` when it holds the whole device. An
 * app claim (ADR 0034) and a `macos-app` lease (ADR 0007, which takes no claim) each scope a
 * session to one app.
 */
export function sessionHeldApp(
  session: Pick<SessionState, 'deviceClaim' | 'lease'>,
): DeviceClaimApp | undefined {
  if (session.lease?.leaseBackend === 'macos-app') return leasedApp(session.lease.deviceKey);
  return session.deviceClaim?.app;
}

/** The app a request admitted under a `macos-app` lease drives. */
export function admittedLeaseApp(
  lease: Pick<DeviceLease, 'backend' | 'deviceKey'> | undefined,
): DeviceClaimApp | undefined {
  return lease?.backend === 'macos-app' ? leasedApp(lease.deviceKey) : undefined;
}

/**
 * Whether a session on the device stands in the way of an open that would hold `openerApp`, or the
 * whole device when `openerApp` is `undefined`. Two sessions on one device conflict unless each
 * holds one app and the apps differ. The new-session conflict check and the `open --wait` that
 * queues on it both decide with this.
 */
export function sessionConflictsWithOpen(
  session: Pick<SessionState, 'deviceClaim' | 'lease'>,
  openerApp: DeviceClaimApp | undefined,
): boolean {
  const heldApp = sessionHeldApp(session);
  return !heldApp || !openerApp || isSameApp(heldApp, openerApp);
}

/** LaunchServices matches bundle ids without regard to case. */
export function isSameApp(a: DeviceClaimApp, b: DeviceClaimApp): boolean {
  return a.bundleId.toLowerCase() === b.bundleId.toLowerCase();
}

function leasedApp(deviceKey: string | undefined): DeviceClaimApp {
  return { bundleId: parseMacOsAppLeaseKey(deviceKey).bundleId };
}
