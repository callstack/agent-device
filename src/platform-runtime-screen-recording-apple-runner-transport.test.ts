import { beforeEach, expect, test, vi } from 'vitest';
import {
  resolveAppleRunnerScreenRecordingTransport,
  withAppleRunnerScreenRecordingTransport,
} from './platform-runtime-screen-recording-apple-runner-transport.ts';
import { expectProducedRunnerRequests } from './__tests__/test-utils/runner-requests.ts';

const runner = vi.hoisted(() => ({
  run: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  runAppleRunnerCommand: runner.run,
  readRunnerSessionLiveness: runner.snapshot,
}));

const device = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'device',
  name: 'iPhone',
  kind: 'device' as const,
  target: 'mobile' as const,
  booted: true,
};

beforeEach(() => {
  vi.clearAllMocks();
});

const macosDevice = {
  ...device,
  appleOs: 'macos' as const,
  id: 'host-macos-local',
  name: 'Mac',
  target: 'desktop' as const,
};

test('scopes an unavailable runner authority instead of falling back to a local lease', async () => {
  await withAppleRunnerScreenRecordingTransport(undefined, async () => {
    const transport = resolveAppleRunnerScreenRecordingTransport();
    expect(transport).toMatchObject({ available: false, authority: 'scoped-provider' });
    await expect(
      transport.start({
        device,
        appBundleId: 'com.example.app',
        outputPath: '/tmp/capture.mp4',
      }),
    ).rejects.toThrow('does not expose durable recording authority');
  });
});

test('passes the recorded session identity into the runner stop dispatch boundary', async () => {
  runner.snapshot.mockReturnValue({ sessionId: 'runner-session-1', liveness: 'ready' });
  runner.run.mockResolvedValue({});
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await transport.stop({ device, runnerSessionId: 'runner-session-1' });

  expect(runner.run).toHaveBeenCalledWith(
    device,
    { command: 'recordStop', appBundleId: undefined },
    { signal: undefined, expectedRunnerSessionId: 'runner-session-1' },
  );
});

test('cancellation after runner acquisition stops only the acquired session', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel after runner acquisition');
  runner.run.mockResolvedValue({});
  runner.snapshot.mockImplementation(() => {
    controller.abort(reason);
    return { sessionId: 'runner-session-2', liveness: 'ready' };
  });
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device,
      appBundleId: 'com.example.app',
      outputPath: '/tmp/capture.mp4',
      signal: controller.signal,
    }),
  ).rejects.toBe(reason);

  expect(runner.run).toHaveBeenLastCalledWith(
    device,
    { command: 'recordStop', appBundleId: 'com.example.app' },
    { expectedRunnerSessionId: 'runner-session-2' },
  );
});

test('does not issue an unowned stop when runner acquisition exposes no session identity', async () => {
  runner.run.mockResolvedValue({});
  runner.snapshot.mockReturnValue(undefined);
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device,
      appBundleId: 'com.example.app',
      outputPath: '/tmp/capture.mp4',
    }),
  ).rejects.toThrow('did not expose a durable runner session identity');

  expect(runner.run).toHaveBeenCalledOnce();
});

test('keeps macOS runner recording ownership local to the requested output path', async () => {
  runner.snapshot.mockReturnValue({ sessionId: 'runner-session-1', liveness: 'ready' });
  runner.run.mockResolvedValue({ recorderStartUptimeMs: 42 });
  const transport = resolveAppleRunnerScreenRecordingTransport();

  await expect(
    transport.start({
      device: macosDevice,
      appBundleId: 'com.apple.TextEdit',
      outputPath: '/tmp/capture.mp4',
    }),
  ).resolves.toEqual({ runnerSessionId: 'runner-session-1', recorderStartUptimeMs: 42 });

  expect(runner.run).toHaveBeenCalledWith(
    macosDevice,
    {
      command: 'recordStart',
      outPath: '/tmp/capture.mp4',
      appBundleId: 'com.apple.TextEdit',
    },
    { signal: undefined },
  );
});

test('local recording requests match their runner-requests.json entries', async () => {
  runner.snapshot.mockReturnValue({ sessionId: 'runner-session-1', liveness: 'ready' });
  runner.run.mockResolvedValue({});
  const transport = resolveAppleRunnerScreenRecordingTransport();
  const simulator = { ...device, kind: 'simulator' as const, id: 'sim' };
  const request = { appBundleId: 'com.example.app', outputPath: '/tmp/capture.mp4' };

  vi.setSystemTime(1_700_000_000_000);
  try {
    await transport.start({ ...request, device, fps: 30 });
  } finally {
    vi.useRealTimers();
  }
  await transport.start({ ...request, device: simulator });
  await transport.start({ ...request, device: macosDevice });
  await transport.stop({
    device,
    runnerSessionId: 'runner-session-1',
    appBundleId: 'com.example.app',
  });
  const controller = new AbortController();
  runner.snapshot.mockImplementationOnce(() => {
    controller.abort(new Error('cancel after runner acquisition'));
    return { sessionId: 'runner-session-2', liveness: 'ready' };
  });
  await expect(
    transport.start({ ...request, device, signal: controller.signal }),
  ).rejects.toThrow();

  const sent = runner.run.mock.calls.map((call) => call[1]);
  expectProducedRunnerRequests(import.meta.filename, [
    ['ios-device.recording-start.fps', sent[0]],
    ['ios-simulator.recording-start.default', sent[1]],
    ['macos.recording-start.output-path', sent[2]],
    ['ios-device.recording-stop.session', sent[3]],
    ['ios-device.recording-start-abort.stop', sent[5]],
  ]);
});
