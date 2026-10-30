import {
  clearRequestAbortRegistration,
  markRequestCanceled,
  registerRequestAbort,
} from '@agent-device/host-kit/request';
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
  resolveRunnerContainerBundleIds: () => ['com.callstack.agentdevice.runner'],
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

test.each([false, true])(
  'clock-anchor capture preserves request cancellation=%s with an independent caller signal',
  async (canceled) => {
    const requestId = `record-anchor-cancel-${canceled}`;
    const registration = registerRequestAbort(requestId)!;
    const callerSignal = new AbortController().signal;
    runnerClient.run.mockReset();
    runnerClient.run.mockImplementationOnce(async () => {
      if (canceled) {
        markRequestCanceled(requestId);
        throw registration.controller.signal.reason;
      }
      throw new Error('clock anchor unavailable');
    });
    try {
      const capture = captureAppleClockAnchor(
        simulator,
        'com.example.app',
        callerSignal,
        requestId,
      );
      if (canceled) {
        await expect(capture).rejects.toMatchObject({
          code: 'COMMAND_FAILED',
          details: { reason: 'request_canceled' },
        });
      } else {
        await expect(capture).resolves.toBeUndefined();
      }
      expect(runnerClient.run).toHaveBeenCalledOnce();
      const forwarded = runnerClient.run.mock.calls[0]?.[2];
      expect(forwarded?.requestId).toBe(requestId);
      expect(forwarded?.signal).toBe(callerSignal);
      expect(callerSignal.aborted).toBe(false);
    } finally {
      clearRequestAbortRegistration(registration);
    }
  },
);
