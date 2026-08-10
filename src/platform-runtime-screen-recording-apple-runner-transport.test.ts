import { expect, test, vi } from 'vitest';
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
