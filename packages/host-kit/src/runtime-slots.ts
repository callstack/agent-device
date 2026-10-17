import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * What one daemon runtime owns of a kind: a module (or a package) keeps its state in slots of an
 * async-local store the runtime enters, so two runtimes in one process never share it. Outside a
 * runtime (a client process, a unit test) the store's own standalone state answers.
 */
export type RuntimeStateHandle = Readonly<{
  /** Runs `fn` as the runtime that owns this state. */
  run<T>(fn: () => T): T;
  /** Binds this state for the rest of the current async context, after the runtime is composed. */
  enter(): void;
  /** Releases what the state holds: each slot's disposer runs, then the slots are forgotten. */
  dispose(): void;
}>;

export type RuntimeSlots = Readonly<{
  /** One piece of state the current runtime owns, created on first use. */
  slot<T>(key: symbol, create: () => T, dispose?: (value: T) => void): T;
  /** The state of one new runtime: enter it before anything reads a slot. */
  createHandle(): RuntimeStateHandle;
}>;

type Slot = { value: unknown; dispose: ((value: never) => void) | undefined };

/** The single owner of the "entered store, else standalone store" pattern; callers declare slots. */
export function defineRuntimeSlots(): RuntimeSlots {
  const storage = new AsyncLocalStorage<Map<symbol, Slot>>();
  const standalone = new Map<symbol, Slot>();
  return {
    slot: (key, create, dispose) => {
      const slots = storage.getStore() ?? standalone;
      if (!slots.has(key)) slots.set(key, { value: create(), dispose });
      return slots.get(key)!.value as never;
    },
    createHandle: () => {
      const owned = new Map<symbol, Slot>();
      return {
        run: (fn) => storage.run(owned, fn),
        enter: () => storage.enterWith(owned),
        dispose: () => {
          for (const { value, dispose } of owned.values()) dispose?.(value as never);
          owned.clear();
        },
      };
    },
  };
}
