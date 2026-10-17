import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeStateHandle } from '@agent-device/host-kit/request';
import type { AndroidAdbExecutor } from './adb-executor.ts';

/**
 * What one daemon runtime owns of the Android helper: the snapshot-helper sessions, their failed
 * starts and pending retirements, and the adb shell-protocol probes, each kept by its own module in
 * a {@link helperRuntimeSlot}. A close tears down only the runtime that closes, so a second runtime
 * in the same process keeps its warm helper. Outside a runtime (a package test, a tool that drives
 * the helper directly) the standalone state answers.
 */
type HelperRuntimeState = { slots: Map<symbol, unknown> };

const createHelperRuntimeState = (): HelperRuntimeState => ({ slots: new Map() });

const helperRuntimeStorage = new AsyncLocalStorage<HelperRuntimeState>();
const standaloneHelperRuntime = createHelperRuntimeState();
const helperRuntimeState = (): HelperRuntimeState =>
  helperRuntimeStorage.getStore() ?? standaloneHelperRuntime;

export function createAndroidHelperRuntimeState(): RuntimeStateHandle {
  const owned = createHelperRuntimeState();
  return {
    run: (fn) => helperRuntimeStorage.run(owned, fn),
    enter: () => helperRuntimeStorage.enterWith(owned),
    dispose: () => owned.slots.clear(),
  };
}

/** One piece of helper state this daemon runtime owns, created on first use. */
export function helperRuntimeSlot<T>(key: symbol, create: () => T): T {
  const { slots } = helperRuntimeState();
  if (!slots.has(key)) slots.set(key, create());
  return slots.get(key) as T;
}

/**
 * adb only forwards a device command's exit status over shell protocol v2. Both ends must support
 * it: adb reports the features it can actually use with the connected device, so this name in that
 * list is the negotiated result rather than a client-side claim.
 */
const SHELL_PROTOCOL_V2_FEATURE = 'shell_v2';
const FEATURE_PROBE_TIMEOUT_MS = 2_000;

const deviceExitStatusForwardingSlot = Symbol('androidDeviceExitStatusForwarding');
const deviceExitStatusForwarding = (): Map<string, boolean> =>
  helperRuntimeSlot(deviceExitStatusForwardingSlot, () => new Map<string, boolean>());

/**
 * Whether the exit status of a host `adb shell` child is the DEVICE command's exit status.
 *
 * Without shell protocol v2 adb exits 0 whenever the connection closed cleanly — including when
 * the device-side command was killed or never finished — so a host exit code says nothing about
 * the device. Callers that would skip a device-side confirmation on the strength of a host exit
 * code must skip only when this answers `true`: an unsupported transport, a failed probe, and an
 * adb too old to know `features` all answer `false`, because none of them proves anything.
 *
 * The negotiated feature set is fixed for a device's connection, so it is probed once per device.
 */
export async function androidAdbForwardsDeviceExitStatus(params: {
  adb: AndroidAdbExecutor;
  deviceKey: string;
  signal?: AbortSignal;
}): Promise<boolean> {
  const cached = deviceExitStatusForwarding().get(params.deviceKey);
  if (cached !== undefined) return cached;
  let stdout: string;
  try {
    const result = await params.adb(['features'], {
      allowFailure: true,
      timeoutMs: FEATURE_PROBE_TIMEOUT_MS,
      ...(params.signal ? { signal: params.signal } : {}),
    });
    // A probe that did not run leaves the transport unknown rather than unsupported: nothing is
    // cached, so the next teardown asks again instead of inheriting a transient failure.
    if (result.exitCode !== 0) return false;
    stdout = result.stdout;
  } catch {
    return false;
  }
  const forwards = parseAndroidAdbFeatures(stdout).includes(SHELL_PROTOCOL_V2_FEATURE);
  deviceExitStatusForwarding().set(params.deviceKey, forwards);
  return forwards;
}

export function resetAndroidAdbShellProtocolProbes(): void {
  deviceExitStatusForwarding().clear();
}

function parseAndroidAdbFeatures(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
