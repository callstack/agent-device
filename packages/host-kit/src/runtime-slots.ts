import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What one daemon runtime owns: a handle over the process's one slot store. The runtime enters
 * it once (through {@link RuntimeStateHandle.run}) and disposes it once at close, so two runtimes
 * in one process never share per-runtime state. Outside a runtime (a client process, a unit
 * test) the store's own standalone slots answer.
 */
export type RuntimeStateHandle = Readonly<{
  /** Runs `fn` as the runtime that owns this state. */
  run<T>(fn: () => T): T;
  /** Releases what the state holds: each slot's disposer runs, then the slots are forgotten. */
  dispose(): void;
}>;

type Slot = { value: unknown; dispose: ((value: never) => void) | undefined };

// One store per process: modules declare only slot keys, and each runtime enters exactly one
// handle of this store.
const storage = new AsyncLocalStorage<Map<symbol, Slot>>();
const standalone = new Map<symbol, Slot>();

/** One piece of state the current runtime owns, created on first use. */
export function runtimeSlot<T>(key: symbol, create: () => T, dispose?: (value: T) => void): T {
  const slots = storage.getStore() ?? standalone;
  if (!slots.has(key)) slots.set(key, { value: create(), dispose });
  return slots.get(key)!.value as never;
}

/** The state of one new runtime: enter it before anything reads a slot. */
export function createRuntimeStateHandle(): RuntimeStateHandle {
  const owned = new Map<symbol, Slot>();
  return {
    run: (fn) => storage.run(owned, fn),
    dispose: () => {
      for (const { value, dispose } of owned.values()) dispose?.(value as never);
      owned.clear();
    },
  };
}
