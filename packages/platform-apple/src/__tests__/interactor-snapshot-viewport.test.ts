import assert from 'node:assert/strict';
import { test } from 'vitest';
import { IOS_SIMULATOR, MACOS_DEVICE } from './device-fixtures.ts';
import { createAppleInteractor } from '../interactor.ts';
import { runnerResultFor } from './recording-runner-provider.ts';

// #3182: an Apple capture publishes the box its rects are measured in — the app-window evidence the
// presentation fold already resolves — without the runner growing a second wire key for it.

test('an Apple runner capture publishes the app-window box its rects are measured in (#3182)', async () => {
  const interactor = createAppleInteractor(
    IOS_SIMULATOR,
    {},
    {
      hasLiveSession: () => true,
      runCommand: async () => runnerResultFor({ command: 'snapshot' }),
    },
  );

  const result = await interactor.snapshot();
  if ('stage' in result) throw new Error('Apple runner snapshot must be presented');

  assert.deepEqual(result.viewport, { width: 390, height: 844 });
});

// The desktop runner's nodes are absolute in window space (#2891), which no single box describes —
// a published viewport would claim a screen the coordinates do not answer to.
test('a macOS app capture publishes no viewport (#3182)', async () => {
  const nodes = [
    {
      index: 0,
      type: 'Application',
      label: 'System Settings',
      rect: { x: 3200, y: -180, width: 1440, height: 900 },
    },
  ];
  const interactor = createAppleInteractor(
    MACOS_DEVICE,
    {},
    { hasLiveSession: () => true, runCommand: async () => ({ nodes }) },
  );

  const result = await interactor.snapshot({ interactiveOnly: true });
  if ('stage' in result) throw new Error('Apple runner snapshot must be presented');

  assert.equal(result.nodes?.length, 1);
  assert.equal('viewport' in result, false);
});
