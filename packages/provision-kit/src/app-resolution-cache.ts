const APP_RESOLUTION_CACHE_TTL_MS = 30_000;

export type AppResolutionCacheScope = {
  platform: 'android' | 'ios' | 'macos';
  deviceId: string;
  variant?: string;
};

type AppResolutionCacheEntry<T> = {
  value: T;
  expiresAtMs: number;
};

type AppResolutionCache<T> = {
  get(scope: AppResolutionCacheScope, target: string): T | undefined;
  set(scope: AppResolutionCacheScope, target: string, value: T): T;
  clear(scope: AppResolutionCacheScope): void;
  invalidateWhile<Result>(
    scope: AppResolutionCacheScope,
    operation: () => Promise<Result>,
  ): Promise<Result>;
};

export function createAppResolutionCache<T>(
  options: { ttlMs?: number; nowMs?: () => number } = {},
): AppResolutionCache<T> {
  const ttlMs = options.ttlMs ?? APP_RESOLUTION_CACHE_TTL_MS;
  const nowMs = options.nowMs ?? Date.now;
  const entries = new Map<string, AppResolutionCacheEntry<T>>();
  const clearScope = (scope: AppResolutionCacheScope): void => {
    const prefix = buildAppResolutionCacheScopePrefix(scope);
    for (const key of entries.keys()) {
      if (key.startsWith(prefix)) {
        entries.delete(key);
      }
    }
  };

  return {
    get(scope, target) {
      const key = buildAppResolutionCacheKey(scope, target);
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAtMs <= nowMs()) {
        entries.delete(key);
        return undefined;
      }
      return entry.value;
    },
    set(scope, target, value) {
      entries.set(buildAppResolutionCacheKey(scope, target), {
        value,
        expiresAtMs: nowMs() + ttlMs,
      });
      return value;
    },
    clear(scope) {
      clearScope(scope);
    },
    async invalidateWhile(scope, operation) {
      clearScope(scope);
      try {
        return await operation();
      } finally {
        // A concurrent name lookup can finish after the initial clear and repopulate stale data.
        clearScope(scope);
      }
    },
  };
}

function buildAppResolutionCacheKey(scope: AppResolutionCacheScope, target: string): string {
  return [scope.platform, scope.deviceId, scope.variant ?? '', target.trim().toLowerCase()].join(
    '\0',
  );
}

function buildAppResolutionCacheScopePrefix(scope: AppResolutionCacheScope): string {
  return [scope.platform, scope.deviceId, ''].join('\0');
}
