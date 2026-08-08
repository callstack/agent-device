import { expect, test } from 'vitest';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { makeSession, makeSessionStore, mockRunCmd } from './session-test-harness.ts';
import { handleSessionInventoryCommands } from '../session-inventory.ts';

const HARMONY_DEVICE = {
  platform: 'harmonyos' as const,
  id: 'harmony-1',
  name: 'HarmonyOS test device',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

async function listApps(appsFilter: 'all' | 'user-installed'): Promise<DaemonResponse | null> {
  const sessionName = `harmony-apps-${appsFilter}`;
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName, HARMONY_DEVICE));
  const req: DaemonRequest = {
    token: 'test-token',
    session: sessionName,
    command: 'apps',
    positionals: [],
    flags: { appsFilter },
  };
  return await handleSessionInventoryCommands({ req, sessionName, sessionStore });
}

test('HarmonyOS apps routes user-installed filtering through Bundle Manager metadata', async () => {
  mockRunCmd
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: 'com.example.application\ncom.ohos.settings\n',
      stderr: '',
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ applicationInfo: { isSystemApp: false } }),
      stderr: '',
    })
    .mockResolvedValueOnce({
      exitCode: 0,
      stdout: JSON.stringify({ applicationInfo: { isSystemApp: true } }),
      stderr: '',
    });

  const response = await listApps('user-installed');

  expect(response).toMatchObject({
    ok: true,
    data: { apps: ['application (com.example.application)'] },
  });
  expect(mockRunCmd.mock.calls.map(([, args]) => args)).toEqual([
    ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'],
    ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-n', 'com.example.application'],
    ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-n', 'com.ohos.settings'],
  ]);
});

test('HarmonyOS apps routes all filtering to the complete Bundle Manager inventory', async () => {
  mockRunCmd.mockResolvedValueOnce({
    exitCode: 0,
    stdout: 'com.example.application\ncom.ohos.settings\n',
    stderr: '',
  });

  const response = await listApps('all');

  expect(response).toMatchObject({
    ok: true,
    data: {
      apps: ['application (com.example.application)', 'settings (com.ohos.settings)'],
    },
  });
  expect(mockRunCmd.mock.calls.map(([, args]) => args)).toEqual([
    ['-t', 'harmony-1', 'shell', 'bm', 'dump', '-a'],
  ]);
});
