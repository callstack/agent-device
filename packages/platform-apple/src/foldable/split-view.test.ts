import fs from 'node:fs';
import { beforeEach, expect, test, vi } from 'vitest';
import { bindTestCommandHost, createLiveTestHostEnvironment } from '@agent-device/test-kit';

vi.mock('../core/runner-client.ts', () => ({
  runAppleRunnerCommand: vi.fn(async () => ({})),
}));

import type { DeviceInfo } from '@agent-device/kernel/device';
import { buildGesturePlan } from '@agent-device/gestures/gesture-plan';
import { runAppleRunnerCommand } from '../core/runner-client.ts';
import { createLocalAppleToolProvider, withAppleToolProvider } from '../core/tool-provider.ts';
import { createAppleInteractor } from '../interactor.ts';
import { IOS_DEVICE, IOS_SIMULATOR } from '../__tests__/device-fixtures.ts';
import {
  IPHONE_17_SINGLE_PANEL,
  IPHONE_DUO_CLOSED,
  IPHONE_DUO_OPEN,
} from '../__tests__/display-fixtures.ts';

bindTestCommandHost();

const mockRunner = vi.mocked(runAppleRunnerCommand);
const viewport = { x: 0, y: 0, width: 951, height: 669 };
const splitPlan = buildGesturePlan({ intent: 'fling', preset: 'split-view-left' }, viewport, 'ios');

beforeEach(() => {
  mockRunner.mockClear();
});

/** A fresh simulator id per test: the daemon keeps each simulator's resolved panel count. */
let simulatorCount = 0;
function simulator(): DeviceInfo {
  simulatorCount += 1;
  return { ...IOS_SIMULATOR, id: `${IOS_SIMULATOR.id}-split-${simulatorCount}` };
}

async function performSplit(device: DeviceInfo, panels: object) {
  const provider = createLocalAppleToolProvider({
    runCommand: async (_command, args) => {
      if (args.slice(0, 4).join(' ') === 'devicectl device info displays') {
        fs.writeFileSync(args.at(-1)!, JSON.stringify(panels));
      }
      return { stdout: '', stderr: '', exitCode: 0 };
    },
  });
  await withAppleToolProvider(provider, () =>
    createAppleInteractor(device, {}, createLiveTestHostEnvironment()).performGesture!(splitPlan),
  );
}

test('an open foldable simulator sends the Split View drag as a screen-edge touch', async () => {
  await performSplit(simulator(), IPHONE_DUO_OPEN);
  expect(mockRunner).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      command: 'gesture',
      gesturePlan: expect.objectContaining({ contactOrigin: 'screen-edge' }),
    }),
    expect.anything(),
  );
});

test.each([
  ['a closed foldable simulator', simulator(), IPHONE_DUO_CLOSED],
  ['a single-panel simulator', simulator(), IPHONE_17_SINGLE_PANEL],
  ['a physical iPhone', IOS_DEVICE, IPHONE_DUO_OPEN],
] as const)('%s refuses Split View before any touch', async (_name, device, panels) => {
  await expect(performSplit(device, panels)).rejects.toMatchObject({
    code: 'UNSUPPORTED_OPERATION',
    details: { reason: 'split_view_unavailable', dispatched: 'no' },
  });
  expect(mockRunner).not.toHaveBeenCalled();
});
