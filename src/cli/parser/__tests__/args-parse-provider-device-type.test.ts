import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseArgs } from '../args.ts';

test('parseArgs reads the TestMu device type and rejects an unknown pool', () => {
  const parsed = parseArgs(['connect', 'testmu', '--provider-device-type', 'real'], {
    strictFlags: true,
  });
  assert.equal(parsed.flags.providerDeviceType, 'real');
  assert.throws(
    () =>
      parseArgs(['connect', 'testmu', '--provider-device-type', 'physical'], {
        strictFlags: true,
      }),
    /Invalid provider-device-type: physical/,
  );
});
