import type { DeviceInfo } from '@agent-device/kernel/device';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { randomUUID } from 'node:crypto';
import { sleep } from '@agent-device/host-kit/retry';
import { normalizeError } from '@agent-device/kernel/errors';
import { emitAndroidAdbDiagnostic, requireAndroidAdbHost } from './adb-host.ts';
import { getAndroidImeHelperDeviceKey } from './ime-helper.ts';
import type { AndroidTestImeFlushRecord } from './ime-recovery-marker.ts';

// Process-lived test-IME ownership state, shared by activation, restore, startup recovery, and
// the emulator kill path.

export type AndroidTestImeOwnership = {
  /** The recovery scope whose lock and marker guard this device's IME. */
  readonly stateDir: string;
  /** A rebind left the helper unconfirmed; text must not reach it before a confirmed rebind. */
  rebindUnconfirmed: boolean;
};

// Android's SettingsProvider persists a setting change asynchronously: `ime set` answers from
// memory and the XML flush follows up to MAX_WRITE_SETTINGS_DELAY_MILLIS later (AOSP
// SettingsState.java, 2020ms cap). A device killed inside that window reboots from the stale
// file, so a restore followed by an immediate `adb emu kill` loses the keyboard on restart.
// The provider exposes no shell flush; holding the kill past the cap is the owning fix. The
// margin past the cap only has to absorb the AtomicFile rename. Exported so tests derive their
// seeded elapsed times and sleep bounds from the window itself, never from a copied number.
export const SETTINGS_PROVIDER_FLUSH_SETTLE_MS = 2_500;

// Each device's newest restore write is a durable flush record in the daemon state dir
// (ime-recovery-marker.ts), so a daemon restart inside the window still holds the kill (#3346).
// Deadlines use the host monotonic clock (AndroidAdbHost.monotonicNowMs), which every process
// on one host boot shares. Skew rule: a wall-clock step cannot shorten a window, in this
// process or the next. A host reboot resets the clock;
// the remaining wait is capped at one window, so a record from an earlier boot over-waits by
// at most SETTINGS_PROVIDER_FLUSH_SETTLE_MS once and is then retired. Expiry rule: a record
// whose deadline has passed costs no wait; the first kill-bound reader retires it, so a
// removed AVD never strands a shutdown. The kill-side wait consumes only the deadline: every
// issued emulator write owes the hold. Marker clearing consumes `confirmed`, and only from a
// record this process wrote: a covered CONFIRMED window lets an uninspected close retire
// another close's retry evidence (see isRecoveryMarkerClearEarned), but a dead process's
// provenance cannot speak for activations that may have followed it.
const FLUSH_RECORD_WRITER = randomUUID();
const androidTestImeFlushRecordLocks = new Map<string, Promise<unknown>>();

function withTestImeFlushRecordLock<T>(
  stateDir: string,
  serial: string,
  task: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(androidTestImeFlushRecordLocks, `${stateDir}:${serial}`, task);
}

// In-flight `ime set` writes, keyed by serial. The provider's window opens when the device
// ACCEPTS the write, but the record exists only after the registrar's finally registers it; a
// kill-bound wait reading records alone would find none and fire adb mid-write. The registrar
// opens the entry before issuing the write and closes it only after that write's record
// registered — every issued emulator `ime set` registers one, whatever the outcome. Only a
// non-emulator restore closes without a record (no flush hazard there). A wait that returned
// just before a write opens cannot be caught by in-process state at all; closing that residue
// needs a lock spanning kill and restore.
const testImePendingRestoreWrites = new Map<string, Set<Promise<void>>>();

/** Opens in-flight tracking for one issued `ime set`; returns the closing function. */
export function beginTestImeRestoreWrite(serial: string): () => void {
  let writes = testImePendingRestoreWrites.get(serial);
  if (!writes) {
    writes = new Set();
    testImePendingRestoreWrites.set(serial, writes);
  }
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  writes.add(settled);
  return () => {
    writes.delete(settled);
    if (writes.size === 0 && testImePendingRestoreWrites.get(serial) === writes) {
      testImePendingRestoreWrites.delete(serial);
    }
    settle();
  };
}

function pendingTestImeRestoreWrite(serial: string): Promise<void> | undefined {
  const writes = testImePendingRestoreWrites.get(serial);
  if (!writes || writes.size === 0) return undefined;
  return Promise.allSettled(writes).then(() => undefined);
}

async function awaitUntilAborted(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    await pending;
    return;
  }
  await new Promise<void>((resolve) => {
    const finish = () => {
      signal.removeEventListener('abort', finish);
      resolve();
    };
    signal.addEventListener('abort', finish, { once: true });
    void pending.then(finish, finish);
  });
}

export type TestImeFlushWait =
  /** No flush record existed to wait for. */
  | 'idle'
  /** Cancelled before covering; the record stays for the next kill-bound caller. */
  | 'aborted'
  /** Covered a window whose newest write issued a restore that never confirmed here. */
  | 'covered-issued'
  /** Covered a window whose newest write this process confirmed by read-back. */
  | 'covered-confirmed';

// Every issued emulator restore registers its record from the registrar's finally, whatever
// the outcome; `confirmed` carries that write's own provenance. A later write REPLACES the
// provenance rather than inheriting it: an issued-unconfirmed write after a confirmed one can
// have re-displaced the IME, and only the newest write's confirmation justifies clearing
// another close's retry evidence. A new deadline is always the latest one, so windows
// coalesce. A failed write never blocks the restore: it warns and returns the deadline it
// could not record, so the calling close can still hold its own kill.
export async function registerTestImeRestore(
  stateDir: string,
  serial: string,
  confirmed: boolean,
): Promise<TestImeFlushRegistration> {
  const host = requireAndroidAdbHost();
  const deadlineMs = host.monotonicNowMs() + SETTINGS_PROVIDER_FLUSH_SETTLE_MS;
  try {
    await withTestImeFlushRecordLock(stateDir, serial, async () => {
      await host.imeFlushRecords.write(stateDir, serial, {
        deadlineMs,
        confirmed,
        writer: FLUSH_RECORD_WRITER,
      });
    });
    return { deadlineMs, recorded: true };
  } catch (error) {
    emitAndroidAdbDiagnostic({
      level: 'warn',
      phase: 'android_test_ime_flush_record_write_failed',
      data: { device: serial, stateDir, error: normalizeError(error).message },
    });
    return { deadlineMs, recorded: false };
  }
}

export type TestImeFlushRegistration = Readonly<{ deadlineMs: number; recorded: boolean }>;

// Holds the caller's kill until a deadline it registered but could not record has passed. No
// later process can see that window, so only the close that issued the write waits it out.
export async function awaitUnrecordedTestImeFlushWindow(
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<TestImeFlushWait> {
  const remainingMs = Math.min(
    deadlineMs - requireAndroidAdbHost().monotonicNowMs(),
    SETTINGS_PROVIDER_FLUSH_SETTLE_MS,
  );
  if (remainingMs > 0) await sleep(remainingMs, signal);
  return signal?.aborted ? 'aborted' : 'covered-issued';
}

// Wait until the device's newest restore write is older than the flush window. Returns 'idle'
// when the state dir holds no record (nothing to wait for), 'covered-issued' or
// 'covered-confirmed' once the newest record's window has elapsed — retiring the record, since
// nothing older can still be unflushed, and reporting that record's provenance — and
// 'aborted' when cancelled first: the caller must then skip the kill, and the record stays so
// the next kill-bound path derives the same remaining wait.
// Rounds repeat until nothing newer appears: a restore landing (or even ISSUING a write) while
// a round sleeps carries a newer deadline, and this caller owns the kill, so reporting covered
// on an older record would release it inside the newer window — #3318 again.
export async function awaitTestImeFlushWindow(
  stateDir: string,
  serial: string,
  signal?: AbortSignal,
): Promise<TestImeFlushWait> {
  if (signal?.aborted) return 'aborted';
  for (;;) {
    const outcome = await runTestImeFlushRound(stateDir, serial, signal);
    if (outcome !== 'extended') return outcome;
  }
}

// One round: drain in-flight writes, then sleep out the newest record's remainder and consume
// exactly that record. 'extended' means a newer deadline appeared and another round must run.
async function runTestImeFlushRound(
  stateDir: string,
  serial: string,
  signal?: AbortSignal,
): Promise<TestImeFlushWait | 'extended'> {
  if (!(await quietTestImeRestoreWrites(serial, signal))) return 'aborted';
  const record = await requireAndroidAdbHost().imeFlushRecords.read(stateDir, serial);
  if (record === undefined) return 'idle';
  const remainingMs = Math.min(
    record.deadlineMs - requireAndroidAdbHost().monotonicNowMs(),
    SETTINGS_PROVIDER_FLUSH_SETTLE_MS,
  );
  if (remainingMs > 0) {
    await sleep(remainingMs, signal);
    if (signal?.aborted) return 'aborted';
  }
  return await consumeTestImeFlushRecord(stateDir, serial, record);
}

// True once no `ime set` this process issued is still unregistered. The registrar closes its
// pending entry only after that write's record registered (non-emulator restores register
// none), so a drained, record-less state truly means no window is owed — including one a
// concurrent waiter just retired, which the caller reports as the conservative 'idle'.
async function quietTestImeRestoreWrites(serial: string, signal?: AbortSignal): Promise<boolean> {
  const pending = pendingTestImeRestoreWrite(serial);
  if (!pending) return true;
  await awaitUntilAborted(pending, signal);
  return !signal?.aborted;
}

// Consume the record one round waited for. Every registration stamps a fresh deadline, so an
// equal record is the one waited on. Unchanged or already retired means covered with that
// record's provenance; a newly opened write or a replaced record means a newer deadline
// exists and the caller must loop. Registration takes the same lock, so the clear cannot
// erase a record the round has not waited for, and an extension survives to its own round.
async function consumeTestImeFlushRecord(
  stateDir: string,
  serial: string,
  waited: AndroidTestImeFlushRecord,
): Promise<TestImeFlushWait | 'extended'> {
  const records = requireAndroidAdbHost().imeFlushRecords;
  return await withTestImeFlushRecordLock(stateDir, serial, async () => {
    if (pendingTestImeRestoreWrite(serial)) return 'extended';
    const current = await records.read(stateDir, serial);
    if (current !== undefined) {
      if (!isSameFlushRecord(current, waited)) return 'extended';
      await records.clear(stateDir, serial);
      // A write issued during that file I/O registers after this clear; its round drains it.
      if (pendingTestImeRestoreWrite(serial)) return 'extended';
    }
    return waited.confirmed && waited.writer === FLUSH_RECORD_WRITER
      ? 'covered-confirmed'
      : 'covered-issued';
  });
}

function isSameFlushRecord(
  left: AndroidTestImeFlushRecord,
  right: AndroidTestImeFlushRecord,
): boolean {
  return (
    left.deadlineMs === right.deadlineMs &&
    left.confirmed === right.confirmed &&
    left.writer === right.writer
  );
}

// Per-daemon-process cache of devices with the test IME active; input-actions.ts reads this to
// route text entry through the broadcast channel.
export const activeTestImeDevices = new Map<string, AndroidTestImeOwnership>();

const androidTestImeRecoveryLocks = new Map<string, Promise<unknown>>();

export function isAndroidTestImeActive(device: DeviceInfo): boolean {
  return activeTestImeDevices.has(getAndroidImeHelperDeviceKey(device));
}

export function getAndroidTestImeOwnership(
  device: DeviceInfo,
): AndroidTestImeOwnership | undefined {
  return activeTestImeDevices.get(getAndroidImeHelperDeviceKey(device));
}

export function withAndroidTestImeRecoveryLock<T>(
  stateDir: string,
  serial: string,
  task: () => Promise<T>,
): Promise<T> {
  return withKeyedLock(androidTestImeRecoveryLocks, `${stateDir}:${serial}`, task);
}

/**
 * @internal Test isolation hook for the active test-IME device set and in-flight restore writes.
 */
export function resetAndroidTestImeActivationCacheForTests(): void {
  activeTestImeDevices.clear();
  testImePendingRestoreWrites.clear();
}

/**
 * @internal Test seam to force the active test-IME state for a device.
 */
export function setAndroidTestImeActiveForTests(
  device: DeviceInfo,
  active: boolean,
  stateDir = '/state',
): void {
  const key = getAndroidImeHelperDeviceKey(device);
  if (active) {
    activeTestImeDevices.set(key, { stateDir, rebindUnconfirmed: false });
  } else {
    activeTestImeDevices.delete(key);
  }
}
