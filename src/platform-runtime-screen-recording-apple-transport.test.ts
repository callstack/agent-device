import { expect, test, vi } from 'vitest';

const runCmdBackground = vi.fn(async (_file: string, _args: string[], _options?: unknown) => ({
  pid: 4242,
  wait: Promise.resolve(),
}));
const buildAppleSimulatorRecordVideoArgs = vi.fn(
  async (_device: unknown, _outputPath: string, _options?: unknown) => [
    'simctl',
    'io',
    'sim',
    'recordVideo',
    '/tmp/capture.mp4',
  ],
);

vi.mock('@agent-device/platform-apple/simctl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-apple/simctl')>();
  return {
    ...actual,
    buildAppleSimulatorRecordVideoArgs: (device: unknown, outputPath: string, options?: unknown) =>
      buildAppleSimulatorRecordVideoArgs(device, outputPath, options),
  };
});
vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return {
    ...actual,
    runCmdBackground: (file: string, args: string[], options?: unknown) =>
      runCmdBackground(file, args, options),
  };
});

import {
  resolveAppleSimulatorScreenRecordingTransport,
  withAppleSimulatorScreenRecordingTransport,
} from './platform-runtime-screen-recording-apple-transport.ts';

const simulator = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'sim',
  name: 'Simulator',
  kind: 'simulator' as const,
  target: 'mobile' as const,
  booted: true,
};

test('scopes an explicit unavailable sentinel instead of falling back to local simctl', async () => {
  await withAppleSimulatorScreenRecordingTransport(undefined, async () => {
    const transport = resolveAppleSimulatorScreenRecordingTransport();
    expect(transport).toMatchObject({ available: false, mode: 'transport-composed' });
    await expect(
      transport.start({ device: simulator, outputPath: '/tmp/capture.mp4' }),
    ).rejects.toThrow('does not expose an Apple simulator screen-recording transport');
  });
});

test('runs the argv the Apple package built for the panel being shown', async () => {
  buildAppleSimulatorRecordVideoArgs.mockResolvedValueOnce([
    'simctl',
    'io',
    simulator.id,
    'recordVideo',
    '--display=LCD',
    '/tmp/duo.mp4',
  ]);
  const controller = new AbortController();
  const transport = resolveAppleSimulatorScreenRecordingTransport();
  await transport.start({
    device: simulator,
    outputPath: '/tmp/duo.mp4',
    signal: controller.signal,
  });
  expect(buildAppleSimulatorRecordVideoArgs).toHaveBeenCalledWith(simulator, '/tmp/duo.mp4', {
    signal: controller.signal,
  });
  expect(runCmdBackground.mock.calls[0]![1]).toEqual([
    'simctl',
    'io',
    simulator.id,
    'recordVideo',
    '--display=LCD',
    '/tmp/duo.mp4',
  ]);
});
