import { test, expect } from 'vitest';
import * as path from 'node:path';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { providerRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  createUnavailableRuntimeFactsForTest,
  mkdtempForTestSync,
  createTestHostEnvironment,
} from '@agent-device/test-kit';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
  mockInspectDeviceRuntimeFacts,
} from '../../../__tests__/support/handlers/session-command-harness.ts';
import {
  makeSessionStore,
  noopInvoke,
} from '../../../__tests__/support/handlers/session-test-harness.ts';
import { makeSession } from '../../../__tests__/support/session-factories.ts';

test('appstate refuses unavailable provider facts before binding the device', async () => {
  const staleDevice: DeviceInfo = {
    platform: 'android',
    id: 'limrun:android:released-lease',
    name: 'Released Limrun Android',
    kind: 'emulator',
    target: 'mobile',
    booted: true,
  };
  const unavailable = createUnavailableRuntimeFactsForTest(
    staleDevice,
    providerRuntimeOwner('limrun', 'stale'),
    {
      available: false,
      reason: 'unsupported-provider-mode',
      hint: 'Limrun requires a matching live provider session for this device.',
    },
  );
  mockInspectDeviceRuntimeFacts.mockResolvedValue(unavailable);
  const sessionStore = makeSessionStore();
  sessionStore.publish('default', makeSession('default', { device: staleDevice }));

  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: async () => {
      throw new Error('appstate must refuse before loading a command surface');
    },
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: 'default',
      command: 'appstate',
      positionals: [],
      flags: { platform: 'android' },
    },
    sessionName: 'default',
    logPath: path.join(mkdtempForTestSync('daemon-appstate-facts-'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.hint).toBe(
      'Limrun requires a matching live provider session for this device.',
    );
  }
  expect(mockInspectDeviceRuntimeFacts).toHaveBeenCalledOnce();
  expect(mockBindDeviceRuntime).not.toHaveBeenCalled();
});
