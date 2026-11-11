import type { EnsureReadyInput } from '@agent-device/contracts/device-readiness-runtime';
import { resolveAndroidSerialAllowlist } from '@agent-device/kernel/device-isolation';
import type { EnvMap } from '@agent-device/kernel/source-value';
import type { DaemonRequest } from './daemon-request.ts';

type RequestFlags = NonNullable<DaemonRequest['flags']>;

/**
 * The request's Android serial allowlist, from `--android-device-allowlist` or the environment,
 * in sorted order. Inventory and every readiness input take the allowlist from here.
 */
export function resolveSortedAndroidSerialAllowlist(
  flags: Pick<RequestFlags, 'androidDeviceAllowlist'>,
  env: EnvMap,
): string[] | undefined {
  const allowlist = resolveAndroidSerialAllowlist(flags.androidDeviceAllowlist, env);
  return allowlist ? [...allowlist].sort() : undefined;
}

/**
 * The readiness input of a request that readies the device its selector names. It carries the
 * request's `--serial` and Android serial allowlist, so readiness only accepts a device the
 * request may use.
 */
export function resolveDeviceReadinessInput(params: {
  flags: Pick<RequestFlags, 'serial' | 'androidDeviceAllowlist'>;
  env: EnvMap;
  deadlineAtMs?: number;
}): EnsureReadyInput {
  return {
    serial: params.flags.serial,
    androidSerialAllowlist: resolveSortedAndroidSerialAllowlist(params.flags, params.env),
    ...(params.deadlineAtMs === undefined ? {} : { deadlineAtMs: params.deadlineAtMs }),
  };
}
