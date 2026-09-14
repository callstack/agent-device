import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, expect, onTestFinished, test, vi } from 'vitest';
import { normalizeError } from '@agent-device/kernel/errors';
import { mkdtempForTestSync } from './__tests__/test-utils/tmp-dir.ts';
import { createAppleScreenRecordingHost } from './platform-runtime-screen-recording-apple-host.ts';
import { startAppleSimulatorRecording } from './platform-runtime-screen-recording-apple-simulator-host.ts';
import { withAppleSimulatorScreenRecordingTransport } from './platform-runtime-screen-recording-apple-transport.ts';

const processes = vi.hoisted(() => ({
  alive: new Map<number, boolean>(),
  starts: new Map<number, string>(),
  commands: new Map<number, string>(),
}));

vi.mock('@agent-device/host-kit/process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent-device/host-kit/process')>()),
  isProcessAlive: (pid: number) => processes.alive.get(pid) ?? false,
  isProcessZombie: () => false,
  readProcessStartTime: (pid: number) => processes.starts.get(pid) ?? null,
  readProcessCommand: (pid: number) => processes.commands.get(pid) ?? null,
  listHostProcesses: async () =>
    [...processes.alive.keys()].map((pid) => ({
      pid,
      command: processes.commands.get(pid) ?? '',
    })),
  signalPidsBestEffort: (pids: readonly number[]) => {
    for (const pid of pids) processes.alive.set(pid, false);
    return pids.length;
  },
  waitForProcessExit: async (pid: number) => !(processes.alive.get(pid) ?? false),
}));

const simulator = {
  platform: 'apple' as const,
  appleOs: 'ios' as const,
  id: 'simulator-id',
  name: 'Simulator',
  kind: 'simulator' as const,
  target: 'mobile' as const,
  booted: true,
};

beforeEach(() => {
  processes.alive.clear();
  processes.starts.clear();
  processes.commands.clear();
});

test.each([
  { exitCode: 16, pid: 43, hasIdentity: true, code: 'DEVICE_IN_USE' },
  { exitCode: 16, pid: 43, hasIdentity: false, code: 'DEVICE_IN_USE' },
  { exitCode: 16, pid: undefined, hasIdentity: false, code: 'DEVICE_IN_USE' },
  { exitCode: 1, pid: 43, hasIdentity: true, code: 'UNKNOWN' },
  { exitCode: 1, pid: 43, hasIdentity: false, code: 'UNKNOWN' },
  { exitCode: 1, pid: undefined, hasIdentity: false, code: 'UNKNOWN' },
])(
  'classifies recorder exit $exitCode with pid=$pid and identity=$hasIdentity',
  async ({ exitCode, pid, hasIdentity, code }) => {
    const root = mkdtempForTestSync('agent-device-recording-busy-');
    const failed = background(pid);
    const stderr =
      'Error starting video recorder: Error Domain=NSPOSIXErrorDomain Code=16 "Resource busy"\nNSLocalizedFailureReason=Host recording is already in progress';
    failed.resolveWait({ stdout: '', stderr, exitCode });
    if (!hasIdentity) {
      processes.starts.clear();
      processes.commands.clear();
    }

    const error = await withTransport(
      failed.process,
      async () =>
        await createAppleScreenRecordingHost().startSimulator(
          simulator,
          path.join(root, 'failed.mp4'),
        ),
    ).then(() => {
      throw new Error('unexpected recording start');
    }, normalizeError);

    expect(error.code).toBe(code);
    if (exitCode === 16) {
      expect(error).toMatchObject({
        retriable: false,
        hint: expect.stringContaining('CoreSimulator'),
        details: { reason: 'apple_simulator_recording_busy', exitCode, stderr },
      });
      expect(error.hint).toContain('record stop');
    } else {
      expect(error.details?.reason).toBeUndefined();
    }
  },
);

test('classifies a recorder exit that settles during the final identity poll', async () => {
  vi.useFakeTimers();
  const failed = background(43);
  const readStart = vi.spyOn(processes.starts, 'get');
  const identityPolls = 2_000 / 25 + 1;
  readStart.mockImplementation(() => {
    if (readStart.mock.calls.length === identityPolls) {
      failed.resolveWait({
        stdout: '',
        stderr: 'Host recording is already in progress',
        exitCode: 16,
      });
    }
    return undefined;
  });
  try {
    const root = mkdtempForTestSync('agent-device-recording-identity-deadline-');
    const starting = withTransport(
      failed.process,
      async () => await startAppleSimulatorRecording(simulator, path.join(root, 'failed.mp4')),
    ).then(() => {
      throw new Error('unexpected recording start');
    }, normalizeError);

    await vi.waitFor(() => expect(readStart).toHaveBeenCalled());
    await vi.runAllTimersAsync();
    expect(readStart).toHaveBeenCalledTimes(identityPolls);
    expect(await starting).toMatchObject({
      code: 'DEVICE_IN_USE',
      details: { reason: 'apple_simulator_recording_busy', exitCode: 16 },
    });
    expect(failed.kill).toHaveBeenCalledWith('SIGINT');
  } finally {
    readStart.mockRestore();
    vi.useRealTimers();
  }
});

test('waits for delayed output and rejects an early nonzero exit', async () => {
  const root = mkdtempForTestSync('agent-device-recording-ready-');
  const outputPath = path.join(root, 'capture.mp4');
  const running = background(42);
  const starting = withTransport(
    running.process,
    async () => await startAppleSimulatorRecording(simulator, outputPath),
  );
  setTimeout(() => fs.writeFileSync(outputPath, 'recording'), 25);
  await expect(starting).resolves.toMatchObject({ markers: [{ pid: 42 }] });

  const failed = background(43);
  failed.resolveWait({ stdout: '', stderr: 'failed', exitCode: 1 });
  await expect(
    withTransport(
      failed.process,
      async () => await startAppleSimulatorRecording(simulator, path.join(root, 'failed.mp4')),
    ),
  ).rejects.toThrow('simctl recordVideo exited with code 1');
  running.resolveWait({ stdout: '', stderr: '', exitCode: 0 });
});

test('cancellation during readiness kills and settles with the exact reason', async () => {
  const root = mkdtempForTestSync('agent-device-recording-cancel-');
  const controller = new AbortController();
  const reason = new Error('cancel simulator readiness');
  const running = background(44);
  const start = vi.fn(() => running.process);
  const starting = withAppleSimulatorScreenRecordingTransport(
    { available: true, mode: 'transport-composed', start },
    async () =>
      await startAppleSimulatorRecording(
        simulator,
        path.join(root, 'capture.mp4'),
        controller.signal,
      ),
  );
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  controller.abort(reason);

  await expect(starting).rejects.toBe(reason);
  expect(running.kill).toHaveBeenCalledWith('SIGINT');
});

test('late provider acquisition after abort is rolled back exactly once', async () => {
  const controller = new AbortController();
  const reason = new Error('cancel ignored provider');
  let resolveStart: ((value: ReturnType<typeof background>['process']) => void) | undefined;
  const late = background(45);
  const transportStart = new Promise<ReturnType<typeof background>['process']>((resolve) => {
    resolveStart = resolve;
  });
  const start = vi.fn(async () => await transportStart);
  const starting = withAppleSimulatorScreenRecordingTransport(
    { available: true, mode: 'transport-composed', start },
    async () =>
      await startAppleSimulatorRecording(simulator, '/tmp/late-provider.mp4', controller.signal),
  );
  await vi.waitFor(() => expect(start).toHaveBeenCalledOnce());
  controller.abort(reason);
  await expect(starting).rejects.toBe(reason);
  resolveStart?.(late.process);
  await vi.waitFor(() => expect(late.kill).toHaveBeenCalledTimes(1));
  expect(late.kill).toHaveBeenCalledWith('SIGINT');
});

test.each([
  { label: 'before the acquisition is observed', abortedInStart: true },
  { label: 'while the transport imports settle', abortedInStart: false },
])(
  'discards a transport rejection that arrives when the start was aborted %s',
  async ({ abortedInStart }) => {
    const root = mkdtempForTestSync('agent-device-recording-rejected-start-');
    const controller = new AbortController();
    const reason = new Error('cancel simulator transport start');
    let rejectStart: ((error: unknown) => void) | undefined;
    const start = vi.fn(() => {
      if (abortedInStart) controller.abort(reason);
      return new Promise<ReturnType<typeof background>['process']>((_resolve, reject) => {
        rejectStart = reject;
      });
    });

    const rejection = observeUnhandledRejections();
    const starting = withAppleSimulatorScreenRecordingTransport(
      { available: true, mode: 'transport-composed', start },
      async () =>
        await startAppleSimulatorRecording(
          simulator,
          path.join(root, 'capture.mp4'),
          controller.signal,
        ),
    );
    const rejected = expect(starting).rejects.toBe(reason);
    await vi.waitFor(() => expect(rejectStart).toBeTypeOf('function'));
    if (!abortedInStart) controller.abort(reason);
    rejectStart?.(controller.signal.reason);

    await rejected;
    await expect(rejection.settle()).resolves.toEqual([]);
  },
);

test('resolved provider acquisition aborted before publication removes partial output and settles', async () => {
  const root = mkdtempForTestSync('agent-device-recording-acquired-abort-');
  const outputPath = path.join(root, 'capture.mp4');
  fs.writeFileSync(outputPath, 'partial recording');
  const controller = new AbortController();
  const reason = new Error('cancel after provider acquisition');
  const acquired = background(47);

  const starting = withAppleSimulatorScreenRecordingTransport(
    {
      available: true,
      mode: 'transport-composed',
      start: () => {
        controller.abort(reason);
        return acquired.process;
      },
    },
    async () => await startAppleSimulatorRecording(simulator, outputPath, controller.signal),
  );

  await expect(starting).rejects.toBe(reason);
  expect(acquired.kill).toHaveBeenCalledTimes(1);
  expect(acquired.kill).toHaveBeenCalledWith('SIGINT');
  expect(fs.existsSync(outputPath)).toBe(false);
});

test('post-publication abort does not kill the adopted process', async () => {
  const root = mkdtempForTestSync('agent-device-recording-adopted-');
  const outputPath = path.join(root, 'capture.mp4');
  fs.writeFileSync(outputPath, 'recording');
  const controller = new AbortController();
  const running = background(46);
  const process = await withTransport(
    running.process,
    async () => await startAppleSimulatorRecording(simulator, outputPath, controller.signal),
  );
  controller.abort(new Error('after publication'));
  expect(running.kill).not.toHaveBeenCalled();
  await process.terminate();
  expect(running.kill).toHaveBeenCalledTimes(1);
  await expect(process.wait).resolves.toMatchObject({ exitCode: 0 });
});

test('publishes the post-exec simulator identity after readiness', async () => {
  const root = mkdtempForTestSync('agent-device-recording-post-exec-');
  const outputPath = path.join(root, 'capture.mp4');
  const running = background(47, `xcrun simctl io ${simulator.id} recordVideo ${outputPath}`);
  const postExecCommand = `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl io ${simulator.id} recordVideo ${outputPath}`;
  setTimeout(() => {
    processes.commands.set(47, postExecCommand);
    fs.writeFileSync(outputPath, 'recording');
  }, 25);

  const process = await withTransport(
    running.process,
    async () => await startAppleSimulatorRecording(simulator, outputPath),
  );

  expect(process.markers?.[0]).toMatchObject({ pid: 47, command: postExecCommand });
  await expect(process.terminate()).resolves.toBeUndefined();
});

test('stops a locally launched simulator recorder after xcrun execs the simctl binary', async () => {
  const root = mkdtempForTestSync('agent-device-recording-xcrun-exec-');
  const outputPath = path.join(root, 'capture.mp4');
  fs.writeFileSync(outputPath, 'recording');
  const running = background(48, `xcrun simctl io ${simulator.id} recordVideo ${outputPath}`);
  const process = await withTransport(
    running.process,
    async () => await startAppleSimulatorRecording(simulator, outputPath),
  );
  processes.commands.set(
    48,
    `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl io ${simulator.id} recordVideo ${outputPath}`,
  );

  const marker = process.markers?.[0];
  if (!marker) throw new Error('missing simulator recording marker');
  await expect(createAppleScreenRecordingHost().inspectProcess(marker)).resolves.toBe(
    'owned-alive',
  );
  await expect(process.terminate()).resolves.toBeUndefined();
  expect(running.kill).toHaveBeenCalledWith('SIGINT');
});

test.each([
  [
    'device',
    (outputPath: string) =>
      `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl io another-simulator recordVideo ${outputPath}`,
  ],
  [
    'output path',
    () =>
      `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl io ${simulator.id} recordVideo /tmp/another.mp4`,
  ],
  [
    'verb',
    (outputPath: string) =>
      `/Library/Developer/PrivateFrameworks/CoreSimulator.framework/Versions/A/Resources/bin/simctl io ${simulator.id} screenshot ${outputPath}`,
  ],
])('does not stop a simctl process whose %s changed after capture', async (_name, observed) => {
  const root = mkdtempForTestSync('agent-device-recording-xcrun-mismatch-');
  const outputPath = path.join(root, 'capture.mp4');
  fs.writeFileSync(outputPath, 'recording');
  const running = background(49, `xcrun simctl io ${simulator.id} recordVideo ${outputPath}`);
  const process = await withTransport(
    running.process,
    async () => await startAppleSimulatorRecording(simulator, outputPath),
  );
  processes.commands.set(49, observed(outputPath));

  const marker = process.markers?.[0];
  if (!marker) throw new Error('missing simulator recording marker');
  await expect(createAppleScreenRecordingHost().inspectProcess(marker)).resolves.toBe(
    'ownership-lost',
  );
  await expect(process.terminate()).rejects.toThrow('process ownership changed');
  expect(running.kill).not.toHaveBeenCalled();
  running.resolveWait({ stdout: '', stderr: '', exitCode: 0 });
});

test('pidless provider process is killed and settled before start fails', async () => {
  const rejection = observeUnhandledRejections();
  const running = background(undefined);
  await expect(
    withTransport(
      running.process,
      async () => await startAppleSimulatorRecording(simulator, '/tmp/pidless.mp4'),
    ),
  ).rejects.toThrow('complete process identity');
  expect(running.kill.mock.calls).toEqual([['SIGINT']]);
  await expect(rejection.settle()).resolves.toEqual([]);
});

test('unpublished recorder cleanup gives SIGINT a grace window before forcing exit', async () => {
  vi.useFakeTimers();
  try {
    const running = background(undefined);
    running.kill.mockImplementationOnce(() => true);
    const starting = withTransport(
      running.process,
      async () => await startAppleSimulatorRecording(simulator, '/tmp/stalled-provider.mp4'),
    );
    const rejected = expect(starting).rejects.toThrow('complete process identity');

    await vi.waitFor(() => expect(running.kill).toHaveBeenCalledWith('SIGINT'));
    await vi.advanceTimersByTimeAsync(4_000);
    expect(running.kill).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await rejected;
    expect(running.kill.mock.calls).toEqual([['SIGINT'], ['SIGKILL']]);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

function observeUnhandledRejections() {
  const messages: string[] = [];
  const listener = (reason: unknown) => {
    messages.push(reason instanceof Error ? reason.message : String(reason));
  };
  process.on('unhandledRejection', listener);
  onTestFinished(() => {
    process.off('unhandledRejection', listener);
  });
  return {
    settle: async () => {
      for (let turn = 0; turn < 2; turn += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      return messages;
    },
  };
}

function background(pid: number | undefined, command?: string) {
  let settle: ((result: { stdout: string; stderr: string; exitCode: number }) => void) | undefined;
  const wait = new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
    settle = resolve;
  });
  if (pid !== undefined) {
    processes.alive.set(pid, true);
    processes.starts.set(pid, `start-${pid}`);
    processes.commands.set(pid, command ?? `xcrun simctl io ${simulator.id} recordVideo`);
  }
  const kill = vi.fn((_signal: NodeJS.Signals) => {
    if (pid !== undefined) processes.alive.set(pid, false);
    settle?.({ stdout: '', stderr: '', exitCode: 1 });
    return true;
  });
  return {
    process: { child: { pid, kill }, wait },
    kill,
    resolveWait: (result: { stdout: string; stderr: string; exitCode: number }) => {
      if (pid !== undefined) processes.alive.set(pid, false);
      settle?.(result);
    },
  };
}

async function withTransport<T>(
  process: ReturnType<typeof background>['process'],
  task: () => Promise<T>,
): Promise<T> {
  return await withAppleSimulatorScreenRecordingTransport(
    { available: true, mode: 'transport-composed', start: () => process },
    task,
  );
}
