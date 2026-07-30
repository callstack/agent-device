import test from 'node:test';

import { runAndroidEmulatorE2E } from './android-emulator-e2e/live-runner.ts';

const enabled = process.env.AGENT_DEVICE_ANDROID_E2E === '1';

test(
  'live Android emulator fixture E2E',
  {
    skip: enabled
      ? false
      : 'Set AGENT_DEVICE_ANDROID_E2E=1 with fixture APK path/id and emulator serial to run.',
  },
  () => runAndroidEmulatorE2E(),
);
