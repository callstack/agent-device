import type { CliFlags } from '@agent-device/contracts/command';
import { mergeDefinedFlags } from '../utils/merge-flags.ts';
import { finalizeParsedArgs, parseRawArgs } from './parser/args.ts';
import { resolveConfigBackedFlagDefaults } from '../cli-schema/cli-config.ts';
import { resolveRemoteConfigDefaults } from './remote-config-flags.ts';
import type { EnvMap } from '../utils/env-map.ts';

export function resolveCliOptions(
  argv: string[],
  options?: {
    cwd?: string;
    env?: EnvMap;
    strictFlags?: boolean;
  },
) {
  const rawParsed = parseRawArgs(argv);
  const env = options?.env ?? process.env;
  const cwd = options?.cwd ?? process.cwd();
  const remoteConfigDefaults = shouldApplyRemoteConfigDefaults(rawParsed.command)
    ? resolveRemoteConfigDefaults({
        remoteConfig: rawParsed.flags.remoteConfig,
        cwd,
        env,
      })
    : {};
  const defaultFlags = mergeDefinedFlags(
    resolveConfigBackedFlagDefaults({
      command: rawParsed.command,
      cwd,
      cliFlags: rawParsed.flags as CliFlags,
      env,
    }),
    remoteConfigDefaults,
  );
  const finalized = finalizeParsedArgs(rawParsed, {
    strictFlags: options?.strictFlags,
    defaultFlags,
  });
  return { ...finalized, providedFlags: rawParsed.providedFlags };
}

function shouldApplyRemoteConfigDefaults(command: string | null): boolean {
  return command !== null;
}
