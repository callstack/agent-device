import { test, expect } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import { makeAndroidSession, makeSessionStore } from '../../../__tests__/test-utils/index.ts';
import { withTargetDeviceResolutionScope } from '../../../core/dispatch-resolve.ts';
import type { DeviceInfo } from '../../../kernel/device.ts';
import { handleSessionCommands } from '../session.ts';

test('capabilities reports supported commands for the selected session device', async () => {
  const sessionName = 'android-capabilities';
  const sessionStore = makeSessionStore('agent-device-capabilities-');
  sessionStore.set(sessionName, makeAndroidSession(sessionName));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: PUBLIC_COMMANDS.capabilities,
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;

  expect(response.data?.device).toMatchObject({
    platform: 'android',
    kind: 'emulator',
  });
  expect(response.data?.availableCommands).toEqual(
    expect.arrayContaining([
      'open',
      'screenshot',
      'snapshot',
      'press',
      'fill',
      'network',
      'perf',
      PUBLIC_COMMANDS.gesture,
    ]),
  );
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.capabilities);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.devices);
});

test('capabilities accepts a stopped Android AVD placeholder for explicit platform discovery', async () => {
  const stoppedAvd: DeviceInfo = {
    platform: 'android',
    id: 'Pixel_8_API_35',
    name: 'Pixel 8 API 35',
    kind: 'emulator',
    booted: false,
  };
  const sessionStore = makeSessionStore('agent-device-capabilities-stopped-avd-');

  const response = await withTargetDeviceResolutionScope(
    async (request) => (request.platform === 'android' ? [stoppedAvd] : []),
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: PUBLIC_COMMANDS.capabilities,
          positionals: [],
          flags: { platform: 'android' },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: async () => ({ ok: true, data: {} }),
      }),
  );

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;

  expect(response.data?.device).toMatchObject({
    platform: 'android',
    id: 'Pixel_8_API_35',
    kind: 'emulator',
    booted: false,
  });
  expect(response.data?.availableCommands).toEqual(
    expect.arrayContaining(['open', 'screenshot', 'snapshot', 'press', 'fill']),
  );
});
