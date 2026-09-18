import type { DeviceInfo } from '@agent-device/kernel/device';
import { emitRequestProgress, throwIfRequestCanceled } from '@agent-device/host-kit/request';
import { Deadline, sleep } from '@agent-device/host-kit/retry';
import type { DaemonRequest } from './daemon-request.ts';
import type { SessionStore } from './session-store.ts';
import type { SessionRecoveryOptions } from './session-recovery-hints.ts';

/**
 * How often a waiting open re-checks its device. Contention ends when another session closes or
 * its owner dies, both of which are host-side changes on an agent timescale; a faster poll would
 * only add reads.
 */
const DEVICE_CONTENTION_POLL_MS = 250;

/**
 * The `--wait <ms>` budget an open carries, or `undefined` when it must not block. A non-positive
 * budget is the caller's own spelling of "don't block", so it is not clamped up to the flag's
 * declared minimum.
 */
export function readOpenWaitBudgetMs(req: DaemonRequest): number | undefined {
  const budgetMs = req.flags?.waitMs;
  return typeof budgetMs === 'number' && budgetMs > 0 ? budgetMs : undefined;
}

/**
 * What this request's `--wait` budget actually spent, for the refusal that ends it.
 *
 * The spend rides on `internal`, which the transport strips, so only the daemon that waited can
 * report a wait and the recovery text can say the budget was spent without a client claiming one
 * that never happened.
 */
export function readOpenWaitAttempt(req: DaemonRequest): SessionRecoveryOptions {
  const waitedMs = req.internal?.openDeviceWait?.waitedMs;
  return waitedMs === undefined ? {} : { waitedMs };
}

/**
 * Spend an open's `--wait` budget waiting for the device it is about to bind, and record what
 * that cost.
 *
 * This runs before the request takes the device's execution lock, which is the whole point: the
 * operations that free a contended device — `close`, `record stop`, the holder's own commands —
 * need that same lock, so an open that waited while holding it would block the only thing that
 * could end its wait. Whatever is decided about the device afterwards stays with the locked open
 * path, which re-checks and refuses on its own authority; this wait only declines to queue for
 * the lock while the device is visibly spoken for.
 *
 * Only another session's claim on the device is waited for. A host-global device claim held by
 * another workspace's daemon is not: that refusal names an operator command rather than a retry,
 * and a budget spent on it buys nothing.
 */
export async function waitForOpenDeviceContention(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  budgetMs: number;
  resolveDevice: () => Promise<DeviceInfo | undefined>;
}): Promise<void> {
  const deadline = Deadline.fromTimeoutMs(params.budgetMs);
  let waitedMs = 0;
  for (;;) {
    const device = await params.resolveDevice();
    const holder = device
      ? findSessionHoldingDevice(params.sessionStore, device.id, params.sessionName)
      : undefined;
    if (!holder || deadline.isExpired()) {
      recordOpenWaitSpend(params.req, waitedMs);
      return;
    }
    emitRequestProgress({
      type: 'command',
      status: 'progress',
      message: `Waiting for ${device!.name}: held by session "${holder}" (${Math.round(
        waitedMs,
      )}ms of the ${Math.round(params.budgetMs)}ms wait budget used)`,
    });
    await sleep(Math.min(DEVICE_CONTENTION_POLL_MS, deadline.remainingMs()));
    waitedMs = deadline.elapsedMs();
    recordOpenWaitSpend(params.req, waitedMs);
    // A client that gave up on the request must not leave the daemon queueing for a device
    // nobody wants any more. Checked after the poll rather than before the first look because
    // whether an already-canceled request runs at all is the request pipeline's own question.
    throwIfRequestCanceled(params.req.meta?.requestId);
  }
}

/** The other session holding `deviceId`, or `undefined` when nothing stands between this open
 * and the device — including when this open's own session is what holds it. */
function findSessionHoldingDevice(
  sessionStore: SessionStore,
  deviceId: string,
  sessionName: string,
): string | undefined {
  const inUse = sessionStore.findByDevice(deviceId);
  if (!inUse || inUse.address === sessionName) return undefined;
  return inUse.address;
}

function recordOpenWaitSpend(req: DaemonRequest, waitedMs: number): void {
  if (waitedMs <= 0) return;
  const internal = (req.internal ??= {});
  internal.openDeviceWait = { waitedMs };
}
