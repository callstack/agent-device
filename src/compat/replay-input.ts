import type { CommandFlags } from '../core/dispatch.ts';
import { AppError } from '../kernel/errors.ts';
import {
  parseReplayScriptDetailed,
  readReplayScriptMetadata,
  type ParsedReplayScript,
  type ReplayScriptMetadata,
} from '../replay/script.ts';

export type ParsedReplayInput = ParsedReplayScript & {
  metadata: ReplayScriptMetadata;
};

export function parseReplayInput(
  script: string,
  flags: CommandFlags | undefined,
): ParsedReplayInput {
  if (flags?.replayBackend && flags.replayBackend !== 'maestro') {
    throw new AppError('INVALID_ARGS', `Unsupported replay backend "${flags.replayBackend}".`);
  }

  return {
    ...parseReplayScriptDetailed(script),
    metadata: readReplayScriptMetadata(script),
  };
}
