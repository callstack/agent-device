import { beforeEach, expect, test, vi } from 'vitest';
import type { DeviceInfo } from '@agent-device/kernel/device';

const { inspectAndroidEmulatorGeneration, readAndroidEmulatorLaunchStartTime } = vi.hoisted(() => ({
  inspectAndroidEmulatorGeneration: vi.fn(),
  readAndroidEmulatorLaunchStartTime: vi.fn(
    async (): Promise<string | null> => 'Mon Nov  9 10:00:00 2026',
  ),
}));
vi.mock('@agent-device/platform-android/device-boot', () => ({
  ANDROID_EMULATOR_GENERATION_BUDGET_MS: 10_000,
  inspectAndroidEmulatorGeneration,
  readAndroidEmulatorLaunchStartTime,
}));

const { runCmd, runCmdDetached, runCmdDetachedMonitored, emitDiagnostic } = vi.hoisted(() => ({
  runCmd: vi.fn(async (_cmd: string, args: readonly string[]) => ({
    stdout: args[0] === 'front' ? 'ASN:0x0-0xa26a26:\n' : '"pid"=17044\n',
    stderr: '',
    exitCode: 0,
  })),
  runCmdDetached: vi.fn(() => 4242),
  runCmdDetachedMonitored: vi.fn((_cmd: string, _args: readonly string[]) => ({
    pid: 5151,
    exited: Promise.resolve<{ pid: number; exitCode?: number; error?: string }>({
      pid: 5151,
      exitCode: 0,
    }),
  })),
  emitDiagnostic: vi.fn(),
}));
vi.mock('@agent-device/host-kit/command', () => ({
  runCmd,
  runCmdDetached,
  runCmdDetachedMonitored,
}));
vi.mock('@agent-device/host-kit/diagnostics', () => ({ emitDiagnostic }));
const { readProcessIdentityFacts, stopProcessAndConfirmExit } = vi.hoisted(() => ({
  readProcessIdentityFacts: vi.fn(async () => ({
    startTime: 'Mon Nov  9 10:00:00 2026',
    command: 'emulator -avd Pixel_9',
    zombie: false,
  })),
  stopProcessAndConfirmExit: vi.fn(async () => ({ status: 'stopped' as const })),
}));
vi.mock('@agent-device/host-kit/process', () => ({
  readProcessIdentityFacts,
  stopProcessAndConfirmExit,
}));

import { createAndroidEmulatorHost } from './platform-runtime-android-emulator-host.ts';

beforeEach(() => {
  inspectAndroidEmulatorGeneration.mockReset();
  readAndroidEmulatorLaunchStartTime.mockClear();
  runCmd.mockClear();
  runCmdDetached.mockClear();
  runCmdDetachedMonitored.mockClear();
  emitDiagnostic.mockClear();
  stopProcessAndConfirmExit.mockClear();
});

const emulator: DeviceInfo = {
  platform: 'android',
  kind: 'emulator',
  id: 'emulator-5558',
  name: 'Pixel_9',
};
const launchIdentity = { pid: 4242, startTime: 'Mon Nov  9 10:00:00 2026' };

test('binds the launched process only when both serial observations match its recorded identity', async () => {
  const host = createAndroidEmulatorHost('linux');
  await host.launch('Pixel_9', true, 90_000);
  expect(readAndroidEmulatorLaunchStartTime).toHaveBeenCalledWith(4242);
  inspectAndroidEmulatorGeneration.mockResolvedValue({ identity: launchIdentity });
  await expect(host.bindLaunchedEmulator!(4242, emulator)).resolves.toEqual(launchIdentity);
  expect(inspectAndroidEmulatorGeneration).toHaveBeenCalledTimes(2);
  // Both observations share one deadline, so the pair is bounded together.
  const calls = inspectAndroidEmulatorGeneration.mock.calls as unknown as Array<
    [unknown, { deadline: unknown }]
  >;
  expect(calls[0]?.[1].deadline).toBeDefined();
  expect(calls[1]?.[1].deadline).toBe(calls[0]?.[1].deadline);
});

test('does not bind an unrelated listener, reused pid, or unavailable observation, and names the miss', async () => {
  const host = createAndroidEmulatorHost('linux');
  await host.launch('Pixel_9', true, 90_000);
  inspectAndroidEmulatorGeneration.mockResolvedValueOnce({
    identity: { ...launchIdentity, pid: 4243 },
  });
  await expect(host.bindLaunchedEmulator!(4242, emulator)).resolves.toBeUndefined();
  inspectAndroidEmulatorGeneration
    .mockResolvedValueOnce({ identity: launchIdentity })
    .mockResolvedValueOnce({ identity: { ...launchIdentity, startTime: 'new' } });
  await expect(host.bindLaunchedEmulator!(4242, emulator)).resolves.toBeUndefined();
  inspectAndroidEmulatorGeneration.mockResolvedValueOnce({ miss: 'listener-read-timeout' });
  await expect(host.bindLaunchedEmulator!(4242, emulator)).resolves.toBeUndefined();
  await expect(host.bindLaunchedEmulator!(4243, emulator)).resolves.toBeUndefined();
  const causes = emitDiagnostic.mock.calls
    .map(([event]) => event as { phase: string; data: { step: string; cause: string } })
    .filter((event) => event.phase === 'android_launch_identity_unbound')
    .map((event) => `${event.data.step}:${event.data.cause}`);
  expect(causes).toEqual([
    'bind:first-launch-mismatch',
    'bind:second-launch-mismatch',
    'bind:first-listener-read-timeout',
  ]);
});

test('a launch whose start time could not be read binds nothing and says so', async () => {
  readAndroidEmulatorLaunchStartTime.mockResolvedValueOnce(null);
  const host = createAndroidEmulatorHost('linux');
  await host.launch('Pixel_9', true, 90_000);
  await expect(host.bindLaunchedEmulator!(4242, emulator)).resolves.toBeUndefined();
  expect(inspectAndroidEmulatorGeneration).not.toHaveBeenCalled();
  expect(emitDiagnostic).toHaveBeenCalledWith(
    expect.objectContaining({
      phase: 'android_launch_identity_unbound',
      data: expect.objectContaining({ step: 'bind', cause: 'launch-start-time-unread' }),
    }),
  );
});

test('a windowed macOS launch hands focus back to the app frontmost before launch', async () => {
  await expect(createAndroidEmulatorHost('darwin').launch('Pixel_9', false, 90_000)).resolves.toBe(
    4242,
  );

  expect(runCmd).toHaveBeenLastCalledWith(
    '/usr/bin/lsappinfo',
    ['info', '-only', 'pid', 'ASN:0x0-0xa26a26:'],
    expect.anything(),
  );
  expect(runCmdDetached).toHaveBeenCalledOnce();
  expect(runCmdDetached).toHaveBeenCalledWith('emulator', ['-avd', 'Pixel_9']);
  expect(runCmdDetachedMonitored).toHaveBeenCalledWith('osascript', [
    '-l',
    'JavaScript',
    '-e',
    expect.stringContaining('activateWithOptions'),
    '4242',
    '17044',
    '90000',
  ]);
});

test('a macOS launch with no readable frontmost app starts no focus watcher', async () => {
  runCmd.mockResolvedValueOnce({ stdout: '', stderr: '', exitCode: 1 });

  await createAndroidEmulatorHost('darwin').launch('Pixel_9', false, 90_000);

  expect(runCmdDetached).toHaveBeenCalledOnce();
  expect(runCmdDetachedMonitored).not.toHaveBeenCalled();
});

test('a failed frontmost-app read still launches the emulator, without a focus watcher', async () => {
  runCmd.mockRejectedValueOnce(new Error('lsappinfo timed out after 1000ms'));

  await expect(createAndroidEmulatorHost('darwin').launch('Pixel_9', false, 90_000)).resolves.toBe(
    4242,
  );

  expect(runCmdDetached).toHaveBeenCalledOnce();
  expect(runCmdDetached).toHaveBeenCalledWith('emulator', ['-avd', 'Pixel_9']);
  expect(runCmdDetachedMonitored).not.toHaveBeenCalled();
});

test('a headless launch has no window to keep in the background', async () => {
  await createAndroidEmulatorHost('darwin').launch('Pixel_9', true, 90_000);

  expect(runCmd).not.toHaveBeenCalled();
  expect(runCmdDetached).toHaveBeenCalledOnce();
  expect(runCmdDetached).toHaveBeenCalledWith('emulator', [
    '-avd',
    'Pixel_9',
    '-no-window',
    '-no-audio',
  ]);
});

test('a launch on another host leaves window focus alone', async () => {
  await createAndroidEmulatorHost('linux').launch('Pixel_9', false, 90_000);

  expect(runCmd).not.toHaveBeenCalled();
  expect(runCmdDetached).toHaveBeenCalledOnce();
  expect(runCmdDetachedMonitored).not.toHaveBeenCalled();
});

test('terminate stops only the emulator this host launched, by its recorded identity', async () => {
  const host = createAndroidEmulatorHost('linux');
  await host.launch('Pixel_9', true, 90_000);

  await host.terminate(4242);

  expect(stopProcessAndConfirmExit).toHaveBeenCalledOnce();
  const [target, budget] = stopProcessAndConfirmExit.mock.calls[0] as unknown as [
    { pid: number; identity: { startTime?: string; matches: (command: string) => boolean } },
    { termTimeoutMs: number; killTimeoutMs: number },
  ];
  expect(target.pid).toBe(4242);
  expect(target.identity.startTime).toBe('Mon Nov  9 10:00:00 2026');
  expect(target.identity.matches('/sdk/emulator/qemu-system-aarch64 -avd Pixel_9 -no-window')).toBe(
    true,
  );
  expect(target.identity.matches('/sdk/emulator/emulator -avd Pixel_9_Pro')).toBe(false);
  expect(budget).toEqual({ termTimeoutMs: 1_500, killTimeoutMs: 1_500 });
});

test('terminate signals nothing for a pid this host did not launch', async () => {
  const host = createAndroidEmulatorHost('linux');
  await host.launch('Pixel_9', true, 90_000);

  await host.terminate(5151);
  expect(stopProcessAndConfirmExit).not.toHaveBeenCalled();

  await host.terminate(4242);
  await host.terminate(4242);
  expect(stopProcessAndConfirmExit).toHaveBeenCalledOnce();
});

test('a terminate that could not prove the exit keeps the launch for a retry', async () => {
  const host = createAndroidEmulatorHost('linux');
  await host.launch('Pixel_9', true, 90_000);
  stopProcessAndConfirmExit.mockResolvedValueOnce({
    status: 'retained',
    reason: 'exit-timeout',
    signal: 'SIGKILL',
  } as never);

  await host.terminate(4242);
  await host.terminate(4242);

  expect(stopProcessAndConfirmExit).toHaveBeenCalledTimes(2);
});

// The focus helper only hands focus back to the previous app, so it is best effort: a helper that
// cannot start never fails the launch or stops the booting emulator.
test.each([
  [
    'throws on spawn',
    () => {
      throw new Error('osascript missing');
    },
  ],
  [
    'reports a spawn error after it starts',
    () => ({
      pid: 0,
      exited: Promise.resolve({ pid: 0, error: 'spawn osascript ENOENT' }),
    }),
  ],
] as const)('a focus helper that %s still returns the emulator pid', async (_name, spawn) => {
  runCmdDetachedMonitored.mockImplementationOnce(spawn);
  const host = createAndroidEmulatorHost('darwin');

  await expect(host.launch('Pixel_9', false, 90_000)).resolves.toBe(4242);

  await vi.waitFor(() =>
    expect(emitDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'android_emulator_focus_return_failed' }),
    ),
  );
  expect(stopProcessAndConfirmExit).not.toHaveBeenCalled();
});
