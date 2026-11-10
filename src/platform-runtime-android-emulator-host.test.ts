import { beforeEach, expect, test, vi } from 'vitest';

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
  runCmd.mockClear();
  runCmdDetached.mockClear();
  runCmdDetachedMonitored.mockClear();
  emitDiagnostic.mockClear();
  stopProcessAndConfirmExit.mockClear();
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
