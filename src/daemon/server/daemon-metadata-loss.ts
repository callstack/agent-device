import { lstatIfPresent } from '@agent-device/host-kit/file';
import type { OwnerIdentity } from '@agent-device/host-kit/process';
import {
  readRegisteredDaemonOwnership,
  type RegisteredDaemonOwnership,
} from '../../daemon-registration.ts';

/** A registration this daemon no longer owns, naming the successor when the record does. */
export type DaemonMetadataLoss = Readonly<{
  state: 'replaced' | 'absent';
  registeredPid?: number;
}>;

/**
 * Which ownership findings are a loss. A table so a state added to `RegisteredDaemonOwnership` has
 * to declare itself here rather than default its way into a report that also cancels the watch.
 *
 * A record that is present but unreadable or names no owner is NOT a loss: the file is on disk and
 * this read learned nothing about its owner, so nothing proves it was taken.
 */
const REPORTED_LOSSES: Readonly<Record<RegisteredDaemonOwnership['state'], boolean>> =
  Object.freeze({
    match: false,
    replaced: true,
    absent: true,
    unreadable: false,
    ownerless: false,
    unproven: false,
  });

/**
 * Whether this daemon's registration is still its own.
 *
 * The loss is invisible to the daemon itself: it keeps answering whatever client still reaches it. A
 * daemon that lost its record used to keep the lock it held, serve nobody, and then delete its
 * successor's metadata when it idled out (#3087).
 */
export function readDaemonMetadataLoss(params: {
  infoPath: string;
  stateDir: string;
  owner: OwnerIdentity;
}): DaemonMetadataLoss | undefined {
  const ownership = readRegisteredDaemonOwnership(params.infoPath, params.owner);
  if (!REPORTED_LOSSES[ownership.state]) return undefined;
  // A vanished state dir is the operator or host removing everything: reporting it would write a
  // `daemon.log` back into a directory that was just pruned.
  if (ownership.state === 'absent' && stateDirGone(params.stateDir)) return undefined;
  return ownership.state === 'replaced'
    ? { state: 'replaced', registeredPid: ownership.identity.pid }
    : { state: 'absent' };
}

/**
 * How often a live daemon re-reads its own registration. There is no event that reports a lost
 * record, so detection is a periodic read; the window sits well under the idle reap (#3087).
 */
const METADATA_LOSS_POLL_MS = 15_000;

/**
 * Reports the moment another process publishes over this daemon's registration or deletes it, then
 * stops: the successor owns the record from that point on, and a superseded daemon can outlive it by
 * hours, so continuing to poll would only re-ask a question already answered.
 */
export function watchDaemonMetadataLoss(params: {
  infoPath: string;
  stateDir: string;
  owner: OwnerIdentity;
  onLoss: (loss: DaemonMetadataLoss) => void;
}): () => void {
  let timer: NodeJS.Timeout | undefined;
  const cancel = (): void => {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
  };
  const poll = (): void => {
    // A pruned state dir ends the watch on its own terms: there is no record left to lose, and a
    // daemon whose directory the operator removed has nothing left to report about it.
    if (stateDirGone(params.stateDir)) {
      cancel();
      return;
    }
    const loss = readDaemonMetadataLoss(params);
    if (!loss) return;
    cancel();
    params.onLoss(loss);
  };
  timer = setInterval(poll, METADATA_LOSS_POLL_MS);
  // An armed watch must never be what keeps a daemon's event loop alive.
  timer.unref?.();
  return cancel;
}

/** Absence of the state dir alone; every other `lstat` failure leaves the dir standing. */
function stateDirGone(stateDir: string): boolean {
  try {
    return lstatIfPresent(stateDir) === undefined;
  } catch {
    return false;
  }
}
