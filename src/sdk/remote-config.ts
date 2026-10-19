import { resolveRemoteConfigProfile as resolveRemoteConfigProfileOnHost } from '@agent-device/remote/remote-config';
import type {
  RemoteConfigProfileOptions,
  ResolvedRemoteConfigProfile,
} from '@agent-device/remote/remote-config-schema';

export type { RemoteConfigProfile } from '@agent-device/remote/remote-config-schema';

/** The released entry: without `env`, the profile resolves against the process's environment. */
export function resolveRemoteConfigProfile(
  options: RemoteConfigProfileOptions,
): ResolvedRemoteConfigProfile {
  return resolveRemoteConfigProfileOnHost({ ...options, env: options.env ?? process.env });
}
