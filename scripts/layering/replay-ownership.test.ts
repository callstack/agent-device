import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPLAY_OWNERSHIP_RULE, replayOwnershipViolations } from './replay-ownership.ts';

test('R71 rejects a planted production file under retired src/replay by name', () => {
  const violations = replayOwnershipViolations(['src/replay/planted-production-file.ts']);

  assert.deepEqual(violations, [
    {
      rule: REPLAY_OWNERSHIP_RULE,
      file: 'src/replay/planted-production-file.ts',
      line: 1,
      message:
        'src/replay/ is retired; caller source acquisition belongs under src/commands/replay/ ' +
        'and replay-test presentation belongs under src/cli/replay-test/.',
    },
  ]);
});

test('R71 accepts the current replay owners', () => {
  assert.deepEqual(
    replayOwnershipViolations([
      'src/commands/replay/script-source-bundle.ts',
      'src/cli/replay-test/reporting.ts',
      'src/daemon/replay-script-source.ts',
    ]),
    [],
  );
});
