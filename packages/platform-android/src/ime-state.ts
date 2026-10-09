import type { DeviceInfo } from '@agent-device/kernel/device';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { sleep } from '@agent-device/host-kit/retry';
import { getAndroidImeHelperDeviceKey } from './ime-helper.ts';

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

// A device's restore mark: when the most recent registered write happened, and whether that
// write confirmed. @internal the map is exported for tests; production touches it only
// through the helpers here.
export type TestImeRestoreMark = Readonly<{
  /** Monotonic process-clock time (performance.now) of the write that earned this mark. */
  atPerfMs: number;
  /** True only when a read-back confirmed the write; an issued-but-unconfirmed write is false. */
  confirmed: boolean;
}>;

// Per-device restore marks, keyed by serial. Timed entirely on the PROCESS MONOTONIC CLOCK
// (performance.now) — never the wall clock, as the field name encodes, because sleep() runs
// on libuv's monotonic loop clock, so a wall-clock-derived remaining time mixes two clocks,
// and a forward NTP/VM-resume step could release the kill inside the window. Marks only move
// forward, so windows coalesce into one wait. A mark's provenance says whether its write
// confirmed by read-back (`confirmed`) or was merely issued. The kill-side wait consumes
// only atPerfMs — every issued emulator write owes the hold. Marker clearing consumes
// `confirmed`: only a covered CONFIRMED window lets an uninspected close retire another
// close's retained retry evidence (see isRecoveryMarkerClearEarned). Every path that may
// `adb emu kill` calls awaitTestImeFlushWindow first, and the kill-bound close consumes the
// outcome so the pending marker clears only under a completed (or never-owed) wait.
// The mark does NOT survive a daemon restart: a dead process's write cannot be re-derived
// here. Restart-durable evidence needs a clock that outlives the process plus an expiry rule
// — the forfeit and its alternatives are tracked as #3346.
export const testImeRestoreMarks = new Map<string, TestImeRestoreMark>();

// In-flight `ime set` writes, keyed by serial. The provider's window opens when the device
// ACCEPTS the write, but the mark exists only after the registrar's finally registers it; a
// kill-bound wait reading marks alone would find none and fire adb mid-write. The registrar
// opens the entry before issuing the write and closes it only after that write's mark
// registered — every issued emulator `ime set` registers one, whatever the outcome. Only a
// non-emulator restore closes without a mark (no flush hazard there). A wait that returned
// just before a write opens cannot be caught by in-process state at all; closing that residue
// needs a lock spanning kill and restore, which the shutdown-runtime contract (commands
// only, no stateDir) cannot form.
// @internal exported for the registrar and for tests.
export const testImePendingRestoreWrites = new Map<string, Set<Promise<void>>>();

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
  /** No registered window existed to wait for. */
  | 'idle'
  /** Cancelled before covering; the mark stays for the next kill-bound caller. */
  | 'aborted'
  /** Covered a window whose newest write issued a restore that never confirmed. */
  | 'covered-issued'
  /** Covered a window whose newest write confirmed by read-back. */
  | 'covered-confirmed';

// Every issued emulator restore registers its mark from the registrar's finally, whatever the
// outcome; `confirmed` carries that write's own provenance. A later write REPLACES the
// provenance rather than inheriting it: an issued-unconfirmed write after a confirmed one can
// have re-displaced the IME, and only the newest write's confirmation justifies clearing
// another close's retry evidence. atPerfMs only moves forward, so windows coalesce.
export function registerTestImeRestore(serial: string, confirmed: boolean): void {
  const previousPerfMs = testImeRestoreMarks.get(serial)?.atPerfMs ?? 0;
  testImeRestoreMarks.set(serial, {
    atPerfMs: Math.max(previousPerfMs, performance.now()),
    confirmed,
  });
}

// Wait until the device's newest restore write is older than the flush window. Returns 'idle'
// when this process has no registered window (nothing to wait for), 'covered-issued' or
// 'covered-confirmed' once the newest mark's window has elapsed — retiring the mark, since
// nothing older can still be unflushed, and reporting that newest mark's provenance — and
// 'aborted' when cancelled first: the caller must then skip the kill, and the mark stays so
// the next kill-bound path derives the same remaining wait.
// Rounds repeat until nothing newer appears: a restore landing (or even ISSUING a write) while
// a round sleeps carries a newer deadline, and this caller owns the kill, so reporting covered
// on an older mark would release it inside the newer window — #3318 again.
export async function awaitTestImeFlushWindow(
  serial: string,
  signal?: AbortSignal,
): Promise<TestImeFlushWait> {
  if (signal?.aborted) return 'aborted';
  for (;;) {
    const outcome = await runTestImeFlushRound(serial, signal);
    if (outcome !== 'extended') return outcome;
  }
}

// One round: drain in-flight writes, then sleep out the newest mark's remainder and consume
// exactly that mark. 'extended' means a newer deadline appeared and another round must run.
async function runTestImeFlushRound(
  serial: string,
  signal?: AbortSignal,
): Promise<TestImeFlushWait | 'extended'> {
  if (!(await quietTestImeRestoreWrites(serial, signal))) return 'aborted';
  const mark = testImeRestoreMarks.get(serial);
  if (mark === undefined) return 'idle';
  const remainingMs = mark.atPerfMs + SETTINGS_PROVIDER_FLUSH_SETTLE_MS - performance.now();
  if (remainingMs > 0) {
    await sleep(remainingMs, signal);
    if (signal?.aborted) return 'aborted';
  }
  return consumeTestImeFlushMark(serial, mark);
}

// True once no `ime set` this process issued is still unregistered. The registrar closes its
// pending entry only after that write's mark registered (non-emulator restores register none),
// so a drained, mark-less state truly means no registered window is owed — including one a
// concurrent waiter just retired, which the caller reports as the conservative 'idle'.
async function quietTestImeRestoreWrites(serial: string, signal?: AbortSignal): Promise<boolean> {
  const pending = pendingTestImeRestoreWrite(serial);
  if (!pending) return true;
  await awaitUntilAborted(pending, signal);
  return !signal?.aborted;
}

// Consume the mark one round waited for — identity, not timestamp: every registration stores
// a fresh object, so a replaced mark is never mistaken for the one waited on. Unchanged or
// already retired means covered with that mark's provenance; a newly opened write or a
// replaced mark means a newer deadline exists and the caller must loop. With no await between
// the read and the delete, the delete cannot erase a mark the round has not waited for, so an
// extension always survives to its own round.
function consumeTestImeFlushMark(
  serial: string,
  waited: TestImeRestoreMark,
): TestImeFlushWait | 'extended' {
  if (pendingTestImeRestoreWrite(serial)) return 'extended';
  const current = testImeRestoreMarks.get(serial);
  if (current === undefined || current === waited) {
    testImeRestoreMarks.delete(serial);
    return waited.confirmed ? 'covered-confirmed' : 'covered-issued';
  }
  return 'extended';
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
 * @internal Test isolation hook for the active test-IME device set and flush timestamps.
 */
export function resetAndroidTestImeActivationCacheForTests(): void {
  activeTestImeDevices.clear();
  testImeRestoreMarks.clear();
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
