import type { CliFlags } from './cli-flags.ts';
import {
  REMOTE_CONFIG_FIELD_SPECS,
  type RemoteConfigProfile,
} from '../remote/remote-config-schema.ts';
import { resolveRemoteConfigProfile } from '../remote/remote-config-core.ts';

// Remote config can supply defaults for any supported CLI flag that exists in the profile schema.
// Command validation later strips unsupported defaults for the active command.
const REMOTE_CONFIG_DEFAULT_FLAG_KEYS = REMOTE_CONFIG_FIELD_SPECS.map(
  (spec) => spec.key,
) as readonly (keyof RemoteConfigProfile)[];

export function profileToCliFlags(profile: RemoteConfigProfile): Partial<CliFlags> {
  const flags: Partial<CliFlags> = {};
  for (const key of REMOTE_CONFIG_DEFAULT_FLAG_KEYS) {
    const value = profile[key];
    if (value !== undefined) {
      (flags as Record<string, unknown>)[key] = value;
    }
  }
  return flags;
}

export function resolveRemoteConfigDefaults(options: {
  remoteConfig?: string;
  cwd: string;
  env: Record<string, string | undefined>;
}): Partial<CliFlags> {
  if (!options.remoteConfig) {
    return {};
  }

  const resolved = resolveRemoteConfigProfile({
    configPath: options.remoteConfig,
    cwd: options.cwd,
    env: options.env,
  });
  return {
    ...profileToCliFlags(resolved.profile),
    remoteConfig: options.remoteConfig,
  };
}
