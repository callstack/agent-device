type MemoTimer = ReturnType<typeof setTimeout>;

type TtlMemoEntry<Value> = {
  value: Value;
  expiresAt?: number;
  timer?: MemoTimer;
};

export type TtlMemo<Key, Value> = {
  get: (key: Key) => Value | undefined;
  set: (key: Key, value: Value) => void;
  delete: (key: Key) => boolean;
  clear: () => void;
};

export type TtlMemoOptions = {
  ttlMs?: number;
  scheduleExpiry?: boolean;
  now?: () => number;
};

const processMemoResets = new Set<() => void>();

export function createTtlMemo<Key, Value>(options: TtlMemoOptions = {}): TtlMemo<Key, Value> {
  const entries = new Map<Key, TtlMemoEntry<Value>>();
  const now = options.now ?? (() => Date.now());

  const clearEntryTimer = (entry: TtlMemoEntry<Value> | undefined): void => {
    if (entry?.timer) {
      clearTimeout(entry.timer);
    }
  };

  const memo: TtlMemo<Key, Value> = {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt !== undefined && entry.expiresAt <= now()) {
        memo.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(key, value) {
      clearEntryTimer(entries.get(key));
      const expiresAt = resolveExpiresAt(options.ttlMs, now);
      const entry: TtlMemoEntry<Value> = { value, expiresAt };
      if (options.scheduleExpiry && expiresAt !== undefined) {
        entry.timer = setTimeout(
          () => {
            entries.delete(key);
          },
          Math.max(0, expiresAt - now()),
        );
        entry.timer.unref?.();
      }
      entries.set(key, entry);
    },
    delete(key) {
      const entry = entries.get(key);
      if (!entry) return false;
      clearEntryTimer(entry);
      return entries.delete(key);
    },
    clear() {
      for (const entry of entries.values()) {
        clearEntryTimer(entry);
      }
      entries.clear();
    },
  };

  processMemoResets.add(memo.clear);
  return memo;
}

export function resetAllProcessMemosForTests(): void {
  for (const reset of processMemoResets) {
    reset();
  }
}

function resolveExpiresAt(ttlMs: number | undefined, now: () => number): number | undefined {
  if (ttlMs === undefined || !Number.isFinite(ttlMs)) return undefined;
  return now() + Math.max(0, ttlMs);
}
