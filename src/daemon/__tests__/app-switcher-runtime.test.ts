import { test } from 'vitest';
import { expectRefusesUnavailableExactOwnerFact } from './runtime-binding-conformance.ts';

const appleDevice = {
  id: 'app-switcher-runtime-ios-simulator',
  name: 'iPhone',
  platform: 'apple',
  appleOs: 'ios',
  kind: 'simulator',
  target: 'mobile',
  booted: true,
} as const;
const unavailable = Object.freeze({
  available: false,
  reason: 'unsupported-device-kind' as const,
  hint: 'app-switcher is supported on Apple simulators and physical devices.',
});

test('rejects an unavailable exact-owner fact before binding', async () => {
  await expectRefusesUnavailableExactOwnerFact({
    command: 'app-switcher',
    device: appleDevice,
    unavailable,
  });
});
