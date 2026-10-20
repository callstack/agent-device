import type { DaemonBinding } from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import { shellQuoteIfNeeded } from '@agent-device/kernel/device-shell';
import { readDaemonRecord } from '@agent-device/daemon-contracts/daemon-resolution';
import { daemonInfoFromRecord, type DaemonInfo } from './daemon-client-metadata.ts';
import { daemonIdentityOf } from './daemon-lifecycle-errors.ts';

/**
 * A client's pin checked against the daemon a state directory registers.
 *
 * A pin instructs the client to use one instance and no other, so a mismatch is a refusal and never a
 * reason to start, replace, or redirect. `absent` says the state directory names no daemon at all,
 * which is not a reason to start one either: the caller pinned an instance, not a place to look.
 * `unaddressable` says a record is there and cannot be read as one, which is a different problem from
 * an instance having gone away: something may well be running, and this client cannot name it.
 */
export type DaemonBindingMismatch = 'absent' | 'unaddressable' | 'replaced';

/**
 * What the state directory's record means for a pin: either a refusal that names what it found, or the
 * record itself — narrowed, so a caller that was not refused has the pinned instance in hand.
 */
export type PinnedDaemonRecord =
  | Readonly<{ mismatch: DaemonBindingMismatch; registered: DaemonInfo | null }>
  | Readonly<{ registered: DaemonInfo }>;

export function readPinnedDaemonRecord(
  binding: DaemonBinding,
  record: ReturnType<typeof readDaemonRecord>,
): PinnedDaemonRecord {
  if (record.status === 'absent') return { mismatch: 'absent', registered: null };
  const registered = record.status === 'present' ? daemonInfoFromRecord(record.record) : null;
  if (!registered) {
    return { mismatch: 'unaddressable', registered: null };
  }
  // Every field is compared, the token included: a replacement that somehow reused the pid and its
  // start time is still a different runtime, and the token is what proves it.
  if (
    registered.token !== binding.token ||
    registered.pid !== binding.pid ||
    registered.processStartTime !== binding.processStartTime
  ) {
    return { mismatch: 'replaced', registered };
  }
  return { registered };
}

/**
 * The refusal a pin produces when a state directory does not name the instance it pins. Nothing has
 * been started, retired, or redirected by the time this is thrown, which is what lets the message
 * state the situation as a fact.
 */
export function daemonBindingMismatchError(
  binding: DaemonBinding,
  refusal: Extract<PinnedDaemonRecord, { mismatch: DaemonBindingMismatch }>,
  stateDir: string,
): AppError {
  const { mismatch, registered } = refusal;
  return new AppError(
    'COMMAND_FAILED',
    mismatch === 'absent'
      ? 'The daemon this client is bound to is no longer registered.'
      : mismatch === 'unaddressable'
        ? 'The record on this state directory cannot be read as a daemon record, so the instance this client is bound to cannot be confirmed.'
        : 'A different daemon instance is registered on this state directory.',
    {
      reason: 'daemon-binding-mismatch',
      mismatch,
      stateDir,
      // The bound token is a credential and goes in a message an operator may paste, so the pin is
      // named by its instance alone; a mismatch is a mismatch whatever the token says.
      bound: { pid: binding.pid, processStartTime: binding.processStartTime },
      ...(registered ? { registered: daemonIdentityOf(registered) } : {}),
      hint:
        mismatch === 'unaddressable'
          ? `Inspect ${shellQuoteIfNeeded(`${stateDir}/daemon.json`)}: a pin is refused against an unreadable record rather than answered with another instance.`
          : 'Bind a client to what a running host returns. A client bound to a host that has stopped will not start or replace a daemon.',
    },
  );
}
