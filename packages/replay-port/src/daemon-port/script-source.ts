import { AppError } from '@agent-device/kernel/errors';
import type { ReplayScriptSourceBundle } from '@agent-device/contracts/replay';

export const REPLAY_SCRIPT_SOURCE_REQUIRED_MESSAGE =
  'This replay request carries no script sources. Replay scripts are read by the client and sent with the request; upgrade the agent-device client that issued it to a version that sends script sources.';

export function readReplayScriptSourceFile(
  bundle: ReplayScriptSourceBundle,
  resolvedPath: string,
): string {
  const script = bundle.files[resolvedPath];
  if (script === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      `replay script source is missing ${resolvedPath}; it was not part of the script sources sent with this request.`,
      { path: resolvedPath, entry: bundle.entry },
    );
  }
  return script;
}
