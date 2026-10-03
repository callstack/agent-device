import { expect, test, vi } from 'vitest';
import { createDoublespeedDeviceSession } from './device-session.ts';
import type { DoublespeedIosSession } from './ios.ts';
import {
  doublespeedIosDevice,
  doublespeedLease,
  doublespeedTestDependencies,
} from './runtime.fixtures.ts';

const IOS_APPS = [
  { bundleId: 'com.example.ios', name: 'Example', installType: 'User' },
  { bundleId: 'com.apple.Preferences', name: 'Settings', installType: 'System' },
];

test('exposes inventory, logs and foreground state without the raw client', async () => {
  const appLogTail = vi.fn(async () => 'line one\nline two\n');
  const foregroundApp = vi.fn(async () => ({ bundleId: 'com.example.ios' }));
  const session = createDoublespeedDeviceSession({
    lease: doublespeedLease(),
    simulatorId: 'sim-a',
    device: doublespeedIosDevice,
    client: { listApps: async () => IOS_APPS, appLogTail, foregroundApp },
    screen: { width: 393, height: 852, scale: 3 },
    dependencies: doublespeedTestDependencies,
  } as unknown as DoublespeedIosSession);

  expect(await session.listApps()).toEqual([
    { id: 'com.example.ios', name: 'Example', installType: 'User' },
  ]);
  expect(await session.listApps('all')).toEqual([
    { id: 'com.apple.Preferences', name: 'Settings', installType: 'System' },
    { id: 'com.example.ios', name: 'Example', installType: 'User' },
  ]);
  expect(await session.readLogs('com.example.ios', 200)).toBe('line one\nline two\n');
  expect(await session.getForegroundApp()).toEqual({ appId: 'com.example.ios' });
  expect(appLogTail.mock.calls[0]).toEqual(['com.example.ios', 200, undefined]);
  expect('client' in session).toBe(false);
});
