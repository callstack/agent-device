import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});

import { runCmd } from '@agent-device/host-kit/command';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  ANDROID_EMULATOR,
  installFakeManagedAgentBrowser,
  mkdtempForTestSync,
  WEB_DESKTOP_DEVICE,
  bindTestCommandHost,
} from '@agent-device/test-kit';
import { platformResourceCleanup } from './platform-runtime-resource-cleanup.ts';

bindTestCommandHost();

const mockRunCmd = vi.mocked(runCmd);

afterEach(() => {
  vi.clearAllMocks();
});

async function closeBrowser(device: DeviceInfo, sessionName: string): Promise<void> {
  const stateDir = mkdtempForTestSync('agent-device-resource-cleanup-web-close-');
  await installFakeManagedAgentBrowser(stateDir);
  await platformResourceCleanup.closeManagedBrowser({
    device,
    sessionName,
    stateDir,
    openSessionNames: () => [sessionName],
  });
}

test('closing a web session tells agent-browser to close right away', async () => {
  mockRunCmd.mockResolvedValue({
    stdout: JSON.stringify({ success: true, data: {} }),
    stderr: '',
    exitCode: 0,
  });

  await closeBrowser(WEB_DESKTOP_DEVICE, 'web-session');

  const closeCall = mockRunCmd.mock.calls.find(([, args]) => (args as string[]).includes('close'));
  // `node <entry> close ...`: the managed backend never runs through its `.bin` shim (#2022).
  expect(closeCall?.[0]).toBe(process.execPath);
  expect((closeCall?.[1] as string[] | undefined)?.slice(1)).toEqual([
    'close',
    '--json',
    '--session',
    'web-session',
  ]);
});

test('a refused web close rejects so the caller can report it', async () => {
  mockRunCmd.mockResolvedValue({
    stdout: JSON.stringify({ success: false, error: 'no active browser session' }),
    stderr: '',
    exitCode: 1,
  });

  await expect(closeBrowser(WEB_DESKTOP_DEVICE, 'web-session')).rejects.toThrow();
});

test('closing a non-web session never reaches the agent-browser process', async () => {
  await closeBrowser(ANDROID_EMULATOR, 'android-session');

  expect(mockRunCmd).not.toHaveBeenCalled();
});
