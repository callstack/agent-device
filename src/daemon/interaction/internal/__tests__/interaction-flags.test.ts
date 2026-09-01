import { expect, test } from 'vitest';
import { unsupportedRefSnapshotFlags } from '../interaction-flags.ts';

test('unsupportedRefSnapshotFlags returns unsupported snapshot flags for @ref flows', () => {
  const unsupported = unsupportedRefSnapshotFlags({
    snapshotDepth: 2,
    snapshotScope: 'Login',
    snapshotRaw: true,
  });
  expect(unsupported).toEqual(['--depth', '--scope', '--raw']);
});
