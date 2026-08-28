import { expect, test, vi } from 'vitest';
import {
  captureAppleClockAnchor,
  runAppleRecordingRunner,
} from './platform-runtime-screen-recording-apple-runner-host.ts';
import { withAppleRunnerScreenRecordingTransport } from './platform-runtime-screen-recording-apple-runner-transport.ts';
import { withAppleSimulatorScreenRecordingTransport } from './platform-runtime-screen-recording-apple-transport.ts';

const runnerClient = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  runAppleRunnerCommand: runnerClient.run,
}));
vi.mock('@agent-device/platform-apple/runner', () => ({
  IOS_RUNNER_CONTAINER_BUNDLE_IDS: ['com.callstack.agentdevice.runner'],
}));

const simulator = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'sim',
  name: 'Simulator',
  kind: 'simulator' as const,
  target: 'mobile' as const,
  booted: true,
};

test('generic scoped runner recording fails closed without invoking local runner mechanics', async () => {
  runnerClient.run.mockReset();
  await withAppleRunnerScreenRecordingTransport(undefined, async () => {
    await expect(
      runAppleRecordingRunner(simulator, {
        kind: 'start',
        appBundleId: 'com.example.app',
        outputPath: '/tmp/capture.mp4',
      }),
    ).rejects.toThrow('does not expose durable recording authority');
  });
  expect(runnerClient.run).not.toHaveBeenCalled();
});

test('focused simulator-only transport never warms a local Apple runner', async () => {
  runnerClient.run.mockReset();
  await withAppleSimulatorScreenRecordingTransport(
    {
      available: true,
      mode: 'transport-composed',
      start: async () => {
        throw new Error('unused');
      },
    },
    async () => {
      await expect(captureAppleClockAnchor(simulator, 'com.example.app')).resolves.toBeUndefined();
    },
  );
  expect(runnerClient.run).not.toHaveBeenCalled();
});
