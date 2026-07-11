import type { CliFlags } from '../commands/cli-grammar/flag-types.ts';
import { mergeDefinedFlags } from './merge-flags.ts';
import { finalizeParsedArgs, parseRawArgs } from '../cli/parser/args.ts';
import { resolveConfigBackedFlagDefaults } from './cli-config.ts';
import { resolveRemoteConfigDefaults } from './remote-config.ts';
import type { EnvMap } from './env-map.ts';

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
