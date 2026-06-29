import type { CommandFlags } from '../core/dispatch.ts';
import { AppError } from '../kernel/errors.ts';
import {
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
} from '../replay/vars.ts';
import { parseMaestroReplayFlow } from './maestro/replay-flow.ts';
import {
  parseReplayScriptDetailed,
  readReplayScriptMetadata,
  type ParsedReplayScript,
  type ReplayScriptMetadata,
} from '../replay/script.ts';

type ReplayCompatParser = {
  parse: (
    script: string,
    options: ReplayCompatParseOptions,
  ) => ParsedReplayScript & { metadata: ReplayScriptMetadata };
};

export type ParsedReplayInput = ParsedReplayScript & {
  metadata: ReplayScriptMetadata;
  updateUnsupportedMessage?: string;
};

type ReplayInputParseOptions = {
  sourcePath?: string;
};

type ReplayCompatParseOptions = ReplayInputParseOptions & {
  platform?: string;
  env?: Record<string, string>;
};

const REPLAY_COMPAT_PARSERS: Record<string, ReplayCompatParser> = {
  maestro: {
    parse: parseMaestroReplayFlow,
  },
};

const COMPAT_UPDATE_UNSUPPORTED_MESSAGE =
  'replay -u is not supported for compat flow input. Convert to .ad first, then update that replay file.';

export function parseReplayInput(
  script: string,
  flags: CommandFlags | undefined,
  options: ReplayInputParseOptions = {},
): ParsedReplayInput {
  const compatParser = readReplayCompatParser(flags);
  if (compatParser) {
    return {
      ...compatParser.parse(script, {
        ...options,
        platform: flags?.platform,
        env: readReplayCompatEnv(flags),
      }),
      updateUnsupportedMessage: COMPAT_UPDATE_UNSUPPORTED_MESSAGE,
    };
  }

  return {
    ...parseReplayScriptDetailed(script),
    metadata: readReplayScriptMetadata(script),
  };
}

function readReplayCompatEnv(flags: CommandFlags | undefined): Record<string, string> {
  return {
    ...collectReplayShellEnv(readReplayShellEnvSource(flags?.replayShellEnv)),
    ...parseReplayCliEnvEntries(readReplayCliEnvEntries(flags?.replayEnv)),
  };
}

function readReplayCompatParser(flags: CommandFlags | undefined): ReplayCompatParser | undefined {
  const backend = flags?.replayBackend;
  if (typeof backend !== 'string') return undefined;
  const parser = REPLAY_COMPAT_PARSERS[backend];
  if (!parser) {
    throw new AppError('INVALID_ARGS', `Unsupported replay backend "${backend}".`);
  }
  return parser;
}
