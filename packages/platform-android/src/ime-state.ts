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

// Per-device last-restore marks, keyed by serial, timed entirely on the PROCESS MONOTONIC
// CLOCK (performance.now) — never the wall clock, as the name suffix encodes. sleep() is
// timed on libuv's monotonic loop clock, so a wall-clock-derived remaining time would mix two
// clocks by construction (the skew stable-capture.ts documents in prose), and a forward step
// from NTP or VM resume could make remainingMs negative and release the kill inside the
// window. One source for both registration and expiry means neither can drift against the
// other. The flush window is a property of the device's SettingsProvider, not of any host
// state dir or of the close that performed the restore. Every restore only moves the mark
// forward, so it can never consume evidence a later kill needs — the wait is always derived
// from the newest write, which is also why windows coalesce into one wait rather than
// stacking. Every path that may `adb emu kill` calls awaitTestImeFlushWindow first; the
// kill-bound close finalization also consumes the outcome so the pending marker clears only
// under a completed (or never-owed) wait.
// Deliberate boundary (PR #3331 review, round ten): the window does NOT survive a daemon
// restart. A write made by a dead process cannot be re-derived here, so a restart within the
// window forfeits the remaining wait for that write — every restore shares this boundary, not
// just startup recovery. Closing it would persist a deadline another process can read, which
// must be wall-clock or boot-time based (reopening the clock-skew class this map's name exists
// to exclude, plus restart detection and a marker-format change) and would thread a
// state-dir file host through the shutdown-runtime contract, which today sees only `commands`.
// The forfeit needs a daemon death, a restart, and a kill-bound close all inside 2.5 s of the
// write. It is a residual the fix neither closes nor worsens: every reachable kill path gained
// a window it never had, and this is the one state a restart can erase. Closing it needs
// restart-durable evidence with an expiry rule and a clock that survives process death —
// tracked as follow-up #3346; it is a boundary decision, not an oversight of this map.
// @internal the map is exported for tests; production touches it only through the helpers here.
export const testImeLastRestoreAtPerfMs = new Map<string, number>();

// In-flight `ime set` writes, keyed by serial. The provider's flush window starts when the
// device ACCEPTS the write, but a mark can only be registered once the shell call returns; a
// kill-bound wait reading the map during that gap would see `idle` and fire adb mid-write —
// the same loss as killing before the flush, with even less waiting (#3318, review round
// eleven). The registrar opens this before issuing the write and closes it once the write's
// mark is registered or the issue definitively failed, so the wait below always drains
// in-flight writes before consulting marks. The sub-millisecond residue — a wait that had
// already returned when a write opens — is decided by adb-server ordering and can only be
// closed by a shared lock across kill and restore, which the shutdown contract cannot form
// (see the round-eleven thread reply).
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

export type TestImeFlushWait = 'idle' | 'covered' | 'aborted';

// The write that earned the window calls this, on every confirmed emulator restore — close-time,
// cross-session, or startup-orphan recovery.
export function registerTestImeRestore(serial: string): void {
  testImeLastRestoreAtPerfMs.set(
    serial,
    Math.max(testImeLastRestoreAtPerfMs.get(serial) ?? 0, performance.now()),
  );
}

// Wait until the device's newest restore write is older than the flush window. Returns 'idle'
// when this process never restored the device (no evidence to wait for), 'covered' once the
// window has elapsed — retiring the timestamp, since nothing older can still be unflushed — and
// 'aborted' when cancelled first: the caller must then skip the kill, and the timestamp stays so
// the next kill-bound path derives the same remaining wait.
// Rounds repeat until nothing newer appears: a restore landing (or even ISSUING a write) while
// a round sleeps carries a newer deadline, and this caller owns the kill, so reporting 'covered'
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
  const restoredAtPerfMs = testImeLastRestoreAtPerfMs.get(serial);
  if (restoredAtPerfMs === undefined) return 'idle';
  const remainingMs = restoredAtPerfMs + SETTINGS_PROVIDER_FLUSH_SETTLE_MS - performance.now();
  if (remainingMs > 0) {
    await sleep(remainingMs, signal);
    if (signal?.aborted) return 'aborted';
  }
  return consumeTestImeFlushMark(serial, restoredAtPerfMs);
}

// True once no `ime set` this process issued is still unregistered. The registrar closes its
// pending entry only after registering the mark (or on a definitively failed write), so a
// drained, mark-less state truly means no registered window is owed — including one a
// concurrent waiter just retired, which the caller reports as the conservative 'idle'.
async function quietTestImeRestoreWrites(serial: string, signal?: AbortSignal): Promise<boolean> {
  const pending = pendingTestImeRestoreWrite(serial);
  if (!pending) return true;
  await awaitUntilAborted(pending, signal);
  return !signal?.aborted;
}

// Consume the mark one round waited for: unchanged or already retired means covered, while a
// newly opened write or a newer mark means a newer deadline exists and the caller must loop.
// With no await between the read and the delete, the delete cannot erase a mark the round has
// not waited for, so an extension always survives to its own round.
function consumeTestImeFlushMark(
  serial: string,
  waitedAtPerfMs: number,
): TestImeFlushWait | 'extended' {
  if (pendingTestImeRestoreWrite(serial)) return 'extended';
  const currentPerfMs = testImeLastRestoreAtPerfMs.get(serial);
  if (currentPerfMs === undefined) return 'covered';
  if (currentPerfMs !== waitedAtPerfMs) return 'extended';
  testImeLastRestoreAtPerfMs.delete(serial);
  return 'covered';
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
  testImeLastRestoreAtPerfMs.clear();
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
