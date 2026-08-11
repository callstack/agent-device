import { beforeEach, expect, test, vi } from 'vitest';
import {
  resolveAppleRunnerScreenRecordingTransport,
  withAppleRunnerScreenRecordingTransport,
} from './platform-runtime-screen-recording-apple-runner-transport.ts';

const runner = vi.hoisted(() => ({
  run: vi.fn(),
  snapshot: vi.fn(),
}));

vi.mock('./platforms/apple/core/runner/runner-client.ts', () => ({
  runAppleRunnerCommand: runner.run,
  getRunnerSessionSnapshot: runner.snapshot,
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
  runner.snapshot.mockReturnValue({ sessionId: 'runner-session-1', alive: true });
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
    return { sessionId: 'runner-session-2', alive: true };
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
