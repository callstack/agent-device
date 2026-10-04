import { AppError } from '@agent-device/kernel/errors';
import { withKeyedLock } from '@agent-device/kernel/keyed-lock';
import { androidAdbResultError } from './adb-failure.ts';
import { normalizeAndroidAdbProvider } from './adb-provider-normalization.ts';
import type {
  AndroidAdbExecutor,
  AndroidAdbProvider,
  AndroidPortReverseEndpoint,
  AndroidPortReverseMapping,
  AndroidPortReverseOptions,
  AndroidPortReverseProvider,
} from './adb-transport.ts';

// Port-reverse ownership: an owner-tracked manager over a provider's reverse capability (or an
// exec-backed fallback), so concurrent sessions cannot silently steal each other's mappings.

export type AndroidExecPortReverseOptions = Readonly<{
  /**
   * Refuses to replace any existing device mapping, including one this provider created
   * (`adb reverse --no-rebind`), for a device that other adb clients also drive. When
   * `adb reverse --list` shows the endpoint after a refusal, the provider throws `COMMAND_FAILED`
   * with `details.reason: 'android_port_reverse_rebind_refused'`; otherwise it throws the adb
   * failure.
   */
  noRebind?: boolean;
}>;

const ANDROID_PORT_REVERSE_REBIND_REFUSED_REASON = 'android_port_reverse_rebind_refused';

const managedAndroidPortReverseProviders = new WeakSet<AndroidPortReverseProvider>();

export function createAndroidPortReverseManager(
  provider: AndroidAdbProvider | AndroidAdbExecutor,
): AndroidPortReverseProvider;
/** Options reach only the exec-backed provider the manager builds over a bare executor. */
export function createAndroidPortReverseManager(
  adb: AndroidAdbExecutor,
  options: AndroidExecPortReverseOptions,
): AndroidPortReverseProvider;
export function createAndroidPortReverseManager(
  provider: AndroidAdbProvider | AndroidAdbExecutor,
  options?: AndroidExecPortReverseOptions,
): AndroidPortReverseProvider {
  const normalized = normalizeAndroidAdbProvider(provider);
  if (normalized.reverse && managedAndroidPortReverseProviders.has(normalized.reverse)) {
    return normalized.reverse;
  }
  const reverse =
    normalized.reverse ?? createExecAndroidPortReverseProvider(normalized.exec, options);
  const active = new Map<AndroidPortReverseEndpoint, AndroidPortReverseMapping>();
  const ensuring = new Map<string, Promise<unknown>>();
  const manager: AndroidPortReverseProvider = {
    async ensure(mapping, options) {
      await withKeyedLock(ensuring, mapping.local, async () => {
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
      });
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
  providerOptions: AndroidExecPortReverseOptions = {},
): AndroidPortReverseProvider {
  const bound = new Map<AndroidPortReverseEndpoint, string | undefined>();
  const list = async (options?: AndroidPortReverseOptions) => {
    const result = await adb(['reverse', '--list'], {
      allowFailure: true,
      signal: options?.signal,
      timeoutMs: options?.timeoutMs,
    });
    if (result.exitCode !== 0) return [];
    return parseAndroidReverseList(result.stdout, bound);
  };
  const remove = async (
    local: AndroidPortReverseEndpoint,
    options?: AndroidPortReverseOptions,
  ): Promise<void> => {
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
    bound.delete(local);
  };
  return {
    async ensure(mapping, options) {
      const noRebind = providerOptions.noRebind === true;
      const result = await adb(
        ['reverse', ...(noRebind ? ['--no-rebind'] : []), mapping.local, mapping.remote],
        { allowFailure: noRebind, signal: options?.signal, timeoutMs: options?.timeoutMs },
      );
      if (result.exitCode !== 0) {
        const existing = (await list(options)).find((listed) => listed.local === mapping.local);
        throw existing
          ? rebindRefusedError(mapping, existing)
          : androidAdbResultError(
              `Failed to ensure Android port reverse ${mapping.local}`,
              result,
              {
                local: mapping.local,
                remote: mapping.remote,
              },
            );
      }
      bound.set(mapping.local, mapping.ownerId);
    },
    remove,
    async removeAllOwned(ownerId, options) {
      const locals = [...bound]
        .filter(([, boundOwnerId]) => boundOwnerId === ownerId)
        .map(([local]) => local);
      for (const local of locals) {
        await remove(local, options);
      }
    },
    list,
  };
}

function rebindRefusedError(
  requested: AndroidPortReverseMapping,
  existing: AndroidPortReverseMapping,
): AppError {
  return new AppError(
    'COMMAND_FAILED',
    `Android port reverse ${requested.local} is already mapped on the device`,
    {
      reason: ANDROID_PORT_REVERSE_REBIND_REFUSED_REASON,
      requested,
      existing,
      hint: `agent-device does not replace an existing reverse mapping on a shared device. Remove the mapping that holds device ${requested.local}, or use another device port.`,
    },
  );
}

function parseAndroidReverseList(
  stdout: string,
  bound: ReadonlyMap<AndroidPortReverseEndpoint, string | undefined>,
): AndroidPortReverseMapping[] {
  return stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string, string] => parts.length >= 3)
    .map(([, local, remote]) => {
      const localEndpoint = local as AndroidPortReverseEndpoint;
      return {
        local: localEndpoint,
        remote: remote as AndroidPortReverseEndpoint,
        ownerId: bound.get(localEndpoint),
      };
    });
}

function isMissingReverseMapping(stdout: string, stderr: string): boolean {
  const text = `${stdout}\n${stderr}`.toLowerCase();
  return text.includes('listener') && text.includes('not found');
}
