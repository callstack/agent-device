import type { CliFlags } from '@agent-device/contracts/command';
import {
  assertSelectorHonorsDevicePin,
  mergeDefinedFlags,
  pickExplicitSelector,
  resolveConfigBackedFlagDefaultsWithProvenance,
  resolveDevicePin,
  resolveSelectorOrigins,
} from '@agent-device/command-surface';
import { finalizeParsedArgs, parseRawArgs } from './parser/args.ts';
import { resolveRemoteConfigDefaults } from './remote-config-flags.ts';
import { type EnvMap } from '@agent-device/kernel/source-value';

export function resolveCliOptions(
  argv: string[],
  options: {
    cwd: string;
    env: EnvMap;
    strictFlags?: boolean;
  },
) {
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
  const explicitFlagKeys = new Set(rawParsed.providedFlags.map((entry) => entry.key));
  // The pin is enforced before the merge: once defaults and typed flags are one object, which
  // selector the caller typed is gone, and a typed selector must fail rather than win (#2161).
  const devicePin = resolveDevicePin(configDefaults.flags, configDefaults.provenance);
  if (devicePin) {
    assertSelectorHonorsDevicePin(
      devicePin,
      pickExplicitSelector(rawParsed.flags, explicitFlagKeys),
      'cli',
    );
  }
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
    selectorOrigins: resolveSelectorOrigins(finalized.flags, explicitFlagKeys, devicePin),
  };
}

function shouldApplyRemoteConfigDefaults(command: string | null): boolean {
  return command !== null;
}
