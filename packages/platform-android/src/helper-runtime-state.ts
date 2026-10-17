import { AsyncLocalStorage } from 'node:async_hooks';
import type { RuntimeStateHandle } from '@agent-device/host-kit/request';

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
