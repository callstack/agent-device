import { test, expect } from 'vitest';
import type { SessionState } from '../../types.ts';

import {
  refreshSessionDeviceIfNeeded,
  selectorTargetsSessionDevice,
} from '../session-device-utils.ts';

const iosSimulatorSession: SessionState = {
  name: 'ios-sim',
  createdAt: Date.now(),
  device: {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    target: 'mobile',
  },
  actions: [],
};

async function withMockedPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await fn();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}

test('refreshSessionDeviceIfNeeded keeps iOS simulator session device on non-mac hosts', async () => {
  const device = await withMockedPlatform('linux', async () =>
    refreshSessionDeviceIfNeeded(iosSimulatorSession.device),
  );

  expect(device).toBe(iosSimulatorSession.device);
});

test('selectorTargetsSessionDevice uses session selector conflicts for simulator set selectors', () => {
  const session: SessionState = {
    ...iosSimulatorSession,
    device: {
      ...iosSimulatorSession.device,
      simulatorSetPath: '/tmp/session-set',
    },
  };

  expect(selectorTargetsSessionDevice({ iosSimulatorDeviceSet: '/tmp/session-set' }, session)).toBe(
    true,
  );
  expect(selectorTargetsSessionDevice({ iosSimulatorDeviceSet: '/tmp/other-set' }, session)).toBe(
    false,
  );
});
