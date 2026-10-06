import { expect, test } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { macOsNativeBackendFacts } from './native-backend-facts.ts';

const mac = {
  platform: 'apple',
  appleOs: 'macos',
  id: 'host',
  name: 'Mac',
  kind: 'device',
  target: 'desktop',
} as const satisfies DeviceInfo;

test('the native backend refuses every runner-only macOS operation at admission', () => {
  const facts = macOsNativeBackendFacts(mac, 'native');
  for (const operation of [
    'screenRecordingStart',
    'screenRecordingReattach',
    'prepareAppleRunner',
    'longPressPoint',
    'back',
    'performGesturePlan',
    'performDirectionalFlingPlan',
    'performMultiTouchGesturePlan',
    'performTargetAuthoredDrag',
    'gestureViewport',
  ]) {
    expect(facts).toHaveProperty(operation, {
      available: false,
      reason: 'unsupported-device-backend',
      hint: expect.stringContaining('AGENT_DEVICE_MACOS_APP_BACKEND'),
    });
  }
});

test('the XCTest backend and other Apple devices keep their own facts', () => {
  expect(macOsNativeBackendFacts(mac, 'xctest')).toEqual({});
  expect(macOsNativeBackendFacts({ ...mac, appleOs: 'ios', kind: 'simulator' }, 'native')).toEqual(
    {},
  );
});
