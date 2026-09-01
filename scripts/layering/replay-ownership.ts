import type { LayeringViolation } from './model.ts';

const RETIRED_REPLAY_ROOT = 'src/replay/';
export const REPLAY_OWNERSHIP_RULE = 'R71 replay-ownership';

export function replayOwnershipViolations(sourceFiles: readonly string[]): LayeringViolation[] {
  return sourceFiles
    .filter((file) => file.startsWith(RETIRED_REPLAY_ROOT))
    .map((file) => ({
      rule: REPLAY_OWNERSHIP_RULE,
      file,
      line: 1,
      message:
        `${RETIRED_REPLAY_ROOT} is retired; caller source acquisition belongs under ` +
        'src/commands/replay/ and replay-test presentation belongs under src/cli/replay-test/.',
    }));
}
