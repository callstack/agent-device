import { AppError } from '@agent-device/kernel/errors';
import { androidAdbResultError } from './adb-failure.ts';
import { normalizeAndroidAdbProvider } from './adb-provider-normalization.ts';
import type {
  AndroidAdbExecutor,
  AndroidAdbProvider,
  AndroidPortReverseEndpoint,
  AndroidPortReverseMapping,
  AndroidPortReverseProvider,
} from './adb-transport.ts';

// Port-reverse ownership: an owner-tracked manager over a provider's reverse capability (or an
// exec-backed fallback), so concurrent sessions cannot silently steal each other's mappings.

const managedAndroidPortReverseProviders = new WeakSet<AndroidPortReverseProvider>();

export function createAndroidPortReverseManager(
  provider: AndroidAdbProvider | AndroidAdbExecutor,
): AndroidPortReverseProvider {
  const normalized = normalizeAndroidAdbProvider(provider);
  if (normalized.reverse && managedAndroidPortReverseProviders.has(normalized.reverse)) {
    return normalized.reverse;
  }
  const reverse = normalized.reverse ?? createExecAndroidPortReverseProvider(normalized.exec);
  const active = new Map<AndroidPortReverseEndpoint, AndroidPortReverseMapping>();
  const manager: AndroidPortReverseProvider = {
    async ensure(mapping, options) {
      const current = active.get(mapping.local);
      if (current && current.ownerId !== mapping.ownerId) {
        throw new AppError(
          'COMMAND_FAILED',
          `Android port reverse ${mapping.local} is already owned by ${current.ownerId ?? 'another session'}`,
          { current, requested: mapping },
        );
      }
      if (current?.remote === mapping.remote) {
        return;
      }
      await reverse.ensure(mapping, options);
      active.set(mapping.local, { ...mapping });
    },
    async remove(local, options) {
      if (!active.has(local)) {
        await reverse.remove(local, options);
        return;
      }
      await reverse.remove(local, options);
      active.delete(local);
    },
    async removeAllOwned(ownerId, options) {
      const locals = [...active.values()]
        .filter((mapping) => mapping.ownerId === ownerId)
        .map((mapping) => mapping.local);
      if (locals.length === 0) {
        await reverse.removeAllOwned(ownerId, options);
        return;
      }
      for (const local of locals) {
        await reverse.remove(local, options);
        active.delete(local);
      }
    },
    async list(options) {
      return reverse.list ? await reverse.list(options) : [...active.values()];
    },
  };
  managedAndroidPortReverseProviders.add(manager);
  return manager;
}

export function createExecAndroidPortReverseProvider(
  adb: AndroidAdbExecutor,
): AndroidPortReverseProvider {
  const owned = new Map<string, Set<AndroidPortReverseEndpoint>>();
  return {
    async ensure(mapping, options) {
      await adb(['reverse', mapping.local, mapping.remote], {
        allowFailure: false,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      if (mapping.ownerId) {
        const ownedLocals = owned.get(mapping.ownerId) ?? new Set<AndroidPortReverseEndpoint>();
        ownedLocals.add(mapping.local);
        owned.set(mapping.ownerId, ownedLocals);
      }
    },
    async remove(local, options) {
      const result = await adb(['reverse', '--remove', local], {
        allowFailure: true,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      if (result.exitCode !== 0 && !isMissingReverseMapping(result.stdout, result.stderr)) {
        throw androidAdbResultError(`Failed to remove Android port reverse ${local}`, result, {
          local,
        });
      }
      for (const locals of owned.values()) {
        locals.delete(local);
      }
    },
    async removeAllOwned(ownerId, options) {
      const locals = [...(owned.get(ownerId) ?? [])];
      for (const local of locals) {
        await this.remove(local, options);
      }
      owned.delete(ownerId);
    },
    async list(options) {
      const result = await adb(['reverse', '--list'], {
        allowFailure: true,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      });
      if (result.exitCode !== 0) return [];
      return parseAndroidReverseList(result.stdout, owned);
    },
  };
}

function parseAndroidReverseList(
  stdout: string,
  owned: ReadonlyMap<string, ReadonlySet<AndroidPortReverseEndpoint>>,
): AndroidPortReverseMapping[] {
  const ownerByLocal = new Map<AndroidPortReverseEndpoint, string>();
  for (const [ownerId, locals] of owned) {
    for (const local of locals) {
      ownerByLocal.set(local, ownerId);
    }
  }
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string, string] => parts.length >= 3)
    .map(([, local, remote]) => {
      const localEndpoint = local as AndroidPortReverseEndpoint;
      return {
        local: localEndpoint,
        remote: remote as AndroidPortReverseEndpoint,
        ownerId: ownerByLocal.get(localEndpoint),
      };
    });
}

function isMissingReverseMapping(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return text.includes('listener') && text.includes('not found');
}
