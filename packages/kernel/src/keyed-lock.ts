import { AsyncLocalStorage } from 'node:async_hooks';

type LockFrame = {
  locks: Map<string, Promise<unknown>>;
  key: string;
  active: boolean;
  descendants: Set<Promise<void>>;
};

/**
 * The locks an async context holds: its own frames and, through `parent`, every enclosing scope's.
 * Parents are live, so a lock a holder scope retains later is visible to scopes nested in it.
 */
type LockScope = {
  parent: LockScope | undefined;
  frames: LockFrame[];
  /** Set on a holder scope while it can still take locks, including the keys it is still taking. */
  holder?: { open: boolean; pending: Set<PendingHold> };
};

type PendingHold = {
  locks: Map<string, Promise<unknown>>;
  key: string;
  acquired: Promise<void>;
};

function findPendingHold(
  locks: Map<string, Promise<unknown>>,
  key: string,
): PendingHold | undefined {
  for (let current = keyedLockStorage.getStore(); current; current = current.parent) {
    for (const pending of current.holder?.pending ?? []) {
      if (pending.locks === locks && pending.key === key) return pending;
    }
  }
  return undefined;
}

/**
 * The frame an enclosing holder is still taking for `key`, once it lands. Queueing behind that hold
 * instead would wait on the holder's own request. Only this rare path awaits: with no pending hold,
 * callers reach `locks` synchronously, so a check made just before cannot go stale. A hold that
 * fails (it was cancelled) fails the caller too, rather than letting it queue unchecked.
 */
async function pendingFrameOnceTaken(pending: PendingHold): Promise<LockFrame | undefined> {
  await pending.acquired;
  return findHeldFrame(pending.locks, pending.key);
}

const keyedLockStorage = new AsyncLocalStorage<LockScope>();

/**
 * The nearest scope that still matters to a new nested scope: one holding an active lock, or an open
 * holder scope that may take one. Skipping the rest keeps chains short in contexts that outlive their
 * locks, such as a callback scheduled from inside a lock task.
 */
function liveScope(scope: LockScope | undefined): LockScope | undefined {
  let current = scope;
  while (current && !current.holder?.open && !current.frames.some((frame) => frame.active)) {
    current = current.parent;
  }
  return current;
}

function activeFrames(scope: LockScope | undefined): LockFrame[] {
  const frames: LockFrame[] = [];
  for (let current = scope; current; current = current.parent) {
    for (const frame of current.frames) if (frame.active) frames.push(frame);
  }
  return frames;
}

function findHeldFrame(locks: Map<string, Promise<unknown>>, key: string): LockFrame | undefined {
  return activeFrames(keyedLockStorage.getStore()).find(
    (frame) => frame.locks === locks && frame.key === key,
  );
}

/**
 * The keys of `locks` the current async context holds through any enclosing scope, together with
 * the keys an enclosing holder scope is still taking, which it will hold.
 */
export function heldKeyedLockKeys(locks: Map<string, Promise<unknown>>): string[] {
  const store = keyedLockStorage.getStore();
  const keys = activeFrames(store)
    .filter((frame) => frame.locks === locks)
    .map((frame) => frame.key);
  for (let current = store; current; current = current.parent) {
    for (const pending of current.holder?.pending ?? []) {
      if (pending.locks === locks && !keys.includes(pending.key)) keys.push(pending.key);
    }
  }
  return keys;
}

async function runInHeldFrame<T>(frame: LockFrame, task: () => Promise<T>): Promise<T> {
  let markSettled!: () => void;
  const settled = new Promise<void>((resolve) => {
    markSettled = resolve;
  });
  frame.descendants.add(settled);
  try {
    return await task();
  } finally {
    frame.descendants.delete(settled);
    markSettled();
  }
}

async function settleFrame(frame: LockFrame): Promise<void> {
  while (frame.descendants.size > 0) await Promise.all(frame.descendants);
  frame.active = false;
}

/**
 * Queues `enter` behind the current holder of `key` and records the queue position in `locks`
 * synchronously, before this returns, so a caller that checked `locks.has(key)` just before cannot
 * see a stale answer. A request that gave up while queued rejects with the signal's reason.
 */
async function acquireKeyedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  enter: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let entered = false;
  const current = previous
    .catch(() => {})
    .then(async () => {
      entered = true;
      signal?.throwIfAborted();
      return await enter();
    });
  locks.set(key, current);
  const completion = current.finally(() => {
    if (locks.get(key) === current) {
      locks.delete(key);
    }
  });
  if (!signal) return await completion;
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      if (!entered) reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    completion.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    if (signal.aborted) onAbort();
  });
}

export async function withKeyedLock<T>(
  locks: Map<string, Promise<unknown>>,
  key: string,
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const held = findHeldFrame(locks, key);
  if (held) return await runInHeldFrame(held, task);
  const pending = findPendingHold(locks, key);
  const landed = pending ? await pendingFrameOnceTaken(pending) : undefined;
  if (landed) return await runInHeldFrame(landed, task);
  const parent = liveScope(keyedLockStorage.getStore());
  return await acquireKeyedLock(
    locks,
    key,
    async () => {
      const frame: LockFrame = { locks, key, active: true, descendants: new Set() };
      try {
        return await keyedLockStorage.run({ parent, frames: [frame] }, task);
      } finally {
        await settleFrame(frame);
      }
    },
    signal,
  );
}

/** Takes locks for the rest of a {@link withKeyedLockHolder} scope. */
export type KeyedLockHolder = Readonly<{
  /**
   * Takes `key` until the holder scope ends. Once taken, every scope nested in the holder scope sees
   * it as held and re-enters it, including scopes that started before it was taken. Holding a key the
   * context already holds, or one this holder is already taking, waits for that same hold.
   */
  hold(locks: Map<string, Promise<unknown>>, key: string, signal?: AbortSignal): Promise<void>;
}>;

type Hold = {
  locks: Map<string, Promise<unknown>>;
  key: string;
  acquired: Promise<void>;
  completion: Promise<void>;
  release(): void;
};

/**
 * Runs `task` in a scope that can take locks partway through and keep them until `task` ends, when
 * they are released after every scope that re-entered them settles.
 */
export async function withKeyedLockHolder<T>(
  task: (holder: KeyedLockHolder) => Promise<T>,
): Promise<T> {
  const state = { open: true, pending: new Set<PendingHold>() };
  const scope: LockScope = {
    parent: liveScope(keyedLockStorage.getStore()),
    frames: [],
    holder: state,
  };
  const holds: Hold[] = [];
  const holder: KeyedLockHolder = Object.freeze({
    hold: async (locks, key, signal) => {
      signal?.throwIfAborted();
      if (!state.open) throw new Error('A keyed lock holder cannot take a lock after it ends.');
      const existing = holds.find((hold) => hold.locks === locks && hold.key === key);
      if (existing) return await existing.acquired;
      if (findHeldFrame(locks, key)) return;
      const enclosing = findPendingHold(locks, key);
      if (enclosing && (await pendingFrameOnceTaken(enclosing))) return;
      const hold = takeHold(scope, locks, key, signal);
      const pending: PendingHold = { locks, key, acquired: hold.acquired };
      state.pending.add(pending);
      holds.push(hold);
      try {
        await hold.acquired;
      } finally {
        state.pending.delete(pending);
      }
    },
  });
  try {
    return await keyedLockStorage.run(scope, async () => await task(holder));
  } finally {
    state.open = false;
    for (const hold of holds) hold.release();
    await Promise.all(holds.map(async (hold) => await hold.completion));
  }
}

function takeHold(
  scope: LockScope,
  locks: Map<string, Promise<unknown>>,
  key: string,
  signal: AbortSignal | undefined,
): Hold {
  let markAcquired: () => void = () => {};
  let rejectAcquired: (error: unknown) => void = () => {};
  let release: () => void = () => {};
  const acquired = new Promise<void>((resolve, reject) => {
    markAcquired = resolve;
    rejectAcquired = reject;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const completion = acquireKeyedLock(
    locks,
    key,
    async () => {
      const frame: LockFrame = { locks, key, active: true, descendants: new Set() };
      scope.frames.push(frame);
      markAcquired();
      try {
        await released;
      } finally {
        await settleFrame(frame);
        scope.frames.splice(scope.frames.indexOf(frame), 1);
      }
    },
    signal,
  );
  completion.catch(rejectAcquired);
  return { locks, key, acquired, completion: completion.catch(() => {}), release };
}
