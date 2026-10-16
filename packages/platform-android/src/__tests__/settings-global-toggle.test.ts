import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { setAndroidGlobalToggle, type AndroidGlobalToggle } from '../settings-global-toggle.ts';
import { withFakeAdb } from './test-utils/fake-adb.ts';
import { underFakeTimers } from './test-utils/fake-timers.ts';

const READ = 'shell settings get global example_on';

const TOGGLE: AndroidGlobalToggle<'example'> = {
  service: 'example',
  row: 'example_on',
  label: 'example',
  stateKey: 'example',
  parseRow: (storedValue) =>
    storedValue === '1' ? 'enabled' : storedValue === '0' ? 'disabled' : undefined,
  notAppliedReason: 'example-not-applied',
  unreadableReason: 'example-unreadable',
  sampleIntervalMs: 300,
  hint: 'Read example_on.',
};

test('the sample taken after the settle window runs out still answers with the typed reason', async () => {
  const readTimeouts: (number | undefined)[] = [];
  await withFakeAdb(
    (args, options) => {
      if (args.join(' ') === READ) readTimeouts.push(options?.timeoutMs);
      return args.join(' ') === READ ? '0' : '';
    },
    async ({ device }) => {
      await expect(
        underFakeTimers(() => setAndroidGlobalToggle(device, TOGGLE, true, undefined)),
      ).rejects.toMatchObject({
        code: 'COMMAND_FAILED',
        details: {
          reason: 'example-not-applied',
          example: 'disabled',
          storedValue: '0',
          dispatched: 'unknown',
        },
      });
    },
  );
  assert.ok(readTimeouts.length > 1);
  for (const timeoutMs of readTimeouts) assert.ok(timeoutMs !== undefined && timeoutMs >= 1_000);
});
