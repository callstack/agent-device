import { expect, test } from 'vitest';
import { refSnapshotFlagGuardResponse } from '../ref-snapshot-flag-policy.ts';

test('refSnapshotFlagGuardResponse rejects unsupported snapshot flags for @ref flows', () => {
  expect(
    refSnapshotFlagGuardResponse('press', {
      snapshotDepth: 2,
      snapshotScope: 'Login',
      snapshotRaw: true,
    }),
  ).toEqual({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      message: 'press @ref does not support --depth, --scope, --raw.',
    },
  });
});
