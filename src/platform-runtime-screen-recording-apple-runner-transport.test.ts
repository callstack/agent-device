import { beforeEach, expect, test, vi } from 'vitest';
import {
  resolveAppleRunnerScreenRecordingTransport,
  withAppleRunnerScreenRecordingTransport,
} from './platform-runtime-screen-recording-apple-runner-transport.ts';

const runner = vi.hoisted(() => ({
  run: vi.fn(),
  snapshot: vi.fn(),
  staleLease: vi.fn(),
  verifyLeaseIdentity: vi.fn(),
}));

const processState = vi.hoisted(() => ({ alive: new Map<number, boolean>() }));

vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  runAppleRunnerCommand: runner.run,
  readRunnerSessionLiveness: runner.snapshot,
  readStaleRunnerLease: runner.staleLease,
  verifyLeaseRunnerPidIdentity: runner.verifyLeaseIdentity,
}));

vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  isProcessAlive: (pid: number) => processState.alive.get(pid) ?? false,
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

test('reads live runner session ownership through the transport inspect seam', async () => {
  const transport = resolveAppleRunnerScreenRecordingTransport();

  runner.snapshot.mockReturnValue({ sessionId: 'runner-session-1', liveness: 'gone' });
  await expect(transport.inspect(device, 'runner-session-1')).resolves.toBe('missing');

  runner.snapshot.mockReturnValue({ sessionId: 'runner-session-1', liveness: 'ready' });
  await expect(transport.inspect(device, 'runner-session-1')).resolves.toBe('owned-alive');
  await expect(transport.inspect(device, 'runner-session-other')).resolves.toBe('ownership-lost');
});

test('falls back to the stale runner lease when no session is registered', async () => {
  const transport = resolveAppleRunnerScreenRecordingTransport();
  runner.snapshot.mockReturnValue(null);
  const lease = {
    schemaVersion: 1 as const,
    deviceId: device.id,
    ownerToken: 'token',
    ownerPid: 300,
    ownerStartTime: null,
    sessionId: 'runner-session-3',
    runnerPid: 4120,
    port: 8100,
    xctestrunPath: '/tmp/Runner.xctestrun',
    jsonPath: '/tmp/lease.json',
    createdAtMs: 1,
  };

  runner.staleLease.mockResolvedValue(null);
  await expect(transport.inspect(device, 'runner-session-3')).resolves.toBe('missing');

  runner.staleLease.mockResolvedValue({ ...lease, sessionId: 'runner-session-other' });
  await expect(transport.inspect(device, 'runner-session-3')).resolves.toBe('ownership-lost');

  runner.staleLease.mockResolvedValue({ ...lease, runnerPid: null });
  await expect(transport.inspect(device, 'runner-session-3')).resolves.toBe('missing');

  processState.alive.set(lease.runnerPid!, false);
  runner.staleLease.mockResolvedValue(lease);
  await expect(transport.inspect(device, 'runner-session-3')).resolves.toBe('missing');

  processState.alive.set(lease.runnerPid!, true);
  runner.verifyLeaseIdentity.mockReturnValue(false);
  await expect(transport.inspect(device, 'runner-session-3')).resolves.toBe('ownership-lost');

  runner.verifyLeaseIdentity.mockReturnValue(true);
  await expect(transport.inspect(device, 'runner-session-3')).resolves.toBe('owned-alive');
  expect(runner.verifyLeaseIdentity).toHaveBeenCalledWith(lease, lease.runnerPid);
});
