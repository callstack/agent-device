import type { CommandFlags } from '@agent-device/contracts/command';
import { AppError } from '@agent-device/kernel/errors';
import { isReplayBackendId, unsupportedReplayBackendMessage } from './format.ts';
import {
  parseReplayScriptDetailed,
  readReplayScriptMetadata,
  type ParsedReplayScript,
  type ReplayScriptMetadata,
} from './script.ts';

export type ParsedReplayInput = ParsedReplayScript & {
  metadata: ReplayScriptMetadata;
};

export function parseReplayInput(
  script: string,
  flags: CommandFlags | undefined,
): ParsedReplayInput {
  // The grammar's own vocabulary guard (#3377): a backend added to `ReplayFormat` needs no edit
  // here, and the daemon's plan-side check stays byte-identical to this one by using the same two
  // functions.
  if (flags?.replayBackend && !isReplayBackendId(flags.replayBackend)) {
    throw new AppError('INVALID_ARGS', unsupportedReplayBackendMessage(flags.replayBackend));
  }

  return {
    ...parseReplayScriptDetailed(script),
    metadata: readReplayScriptMetadata(script),
  };
}
