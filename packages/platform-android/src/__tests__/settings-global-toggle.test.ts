import { expect, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  ANDROID_GLOBAL_TOGGLE_REASONS,
  setAndroidGlobalToggle,
  type AndroidGlobalToggle,
} from '../settings-global-toggle.ts';
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
  notAppliedReason: ANDROID_GLOBAL_TOGGLE_REASONS.mobileDataNotApplied.reason,
  unreadableReason: ANDROID_GLOBAL_TOGGLE_REASONS.mobileDataUnreadable.reason,
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
          reason: ANDROID_GLOBAL_TOGGLE_REASONS.mobileDataNotApplied.reason,
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
