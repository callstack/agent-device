import test from 'node:test';

import { runIosSimulatorE2E } from './ios-simulator-e2e/live-runner.ts';

const enabled = process.env.AGENT_DEVICE_IOS_E2E === '1';

test(
  'live iOS simulator fixture E2E',
  {
    skip: enabled
      ? false
      : 'Set AGENT_DEVICE_IOS_E2E=1 with fixture path/id and simulator UDID to run.',
  },
  runIosSimulatorE2E,
);
