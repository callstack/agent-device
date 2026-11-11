import type { CliFlags } from '@agent-device/contracts/command';
import {
  type DevicePin,
  mergeDefinedFlags,
  resolveConfigBackedFlagDefaultsWithProvenance,
  resolveDevicePin,
} from '@agent-device/command-surface';
import { finalizeParsedArgs, parseRawArgs } from './parser/args.ts';
import { resolveRemoteConfigDefaults } from './remote-config-flags.ts';
import { type EnvMap } from '@agent-device/kernel/source-value';

export type ResolvedCliOptions = ReturnType<typeof finalizeParsedArgs> & {
  providedFlags: ReturnType<typeof parseRawArgs>['providedFlags'];
  remoteConfigLeaseProvider: ReturnType<typeof resolveRemoteConfigDefaults>['leaseProvider'];
  /** Enforced on every finished daemon request by the client (`assertRequestHonorsDevicePin`). */
  devicePin: DevicePin | undefined;
};

export function resolveCliOptions(
  argv: string[],
  options: {
    cwd: string;
    env: EnvMap;
    strictFlags?: boolean;
  },
): ResolvedCliOptions {
  const rawParsed = parseRawArgs(argv);
  const { env, cwd } = options;
  const remoteConfig = shouldApplyRemoteConfigDefaults(rawParsed.command)
    ? resolveRemoteConfigDefaults({
        remoteConfig: rawParsed.flags.remoteConfig,
        cwd,
        env,
      })
    : { flags: {} };
  const configDefaults = resolveConfigBackedFlagDefaultsWithProvenance({
    command: rawParsed.command,
    cwd,
    cliFlags: rawParsed.flags as CliFlags,
    env,
  });
  const devicePin = resolveDevicePin(configDefaults, rawParsed.flags.devicePin);
  const defaultFlags = mergeDefinedFlags(configDefaults.flags, remoteConfig.flags);
  const finalized = finalizeParsedArgs(rawParsed, {
    strictFlags: options?.strictFlags,
    defaultFlags,
  });
  // The flags drop the profile's lease provider, which decides whether a session is required (#3931).
  return {
    ...finalized,
    providedFlags: rawParsed.providedFlags,
    remoteConfigLeaseProvider: remoteConfig.leaseProvider,
    devicePin,
  };
}

function shouldApplyRemoteConfigDefaults(command: string | null): boolean {
  return command !== null;
}
