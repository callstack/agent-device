import type { CliFlags } from '@agent-device/contracts/command';
import { mergeDefinedFlags, resolveConfigBackedFlagDefaults } from '@agent-device/command-surface';
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
  const defaultFlags = mergeDefinedFlags(
    resolveConfigBackedFlagDefaults({
      command: rawParsed.command,
      cwd,
      cliFlags: rawParsed.flags as CliFlags,
      env,
    }),
    remoteConfig.flags,
  );
  const finalized = finalizeParsedArgs(rawParsed, {
    strictFlags: options?.strictFlags,
    defaultFlags,
  });
  // The flags drop the profile's lease provider, which decides whether a session is required (#3931).
  return {
    ...finalized,
    providedFlags: rawParsed.providedFlags,
    remoteConfigLeaseProvider: remoteConfig.leaseProvider,
  };
}

function shouldApplyRemoteConfigDefaults(command: string | null): boolean {
  return command !== null;
}
