import type { AppLogOutputSink, AppLogRuntimeHost } from '@agent-device/contracts/app-log-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { expect, test, vi } from 'vitest';
import { startAppleAppLogs } from './start.ts';
import { appleDevice, hostFixture } from './runtime.fixtures.ts';

test('simulator start resolves its app container through appleTools and keeps plutil generic', async () => {
  const appleToolRun = vi.fn(async () => ({
    stdout: '/tmp/Example.app\n',
    stderr: '',
    exitCode: 0,
  }));
  const commandRun = vi.fn(async (request) => {
    if (request.executable === 'xcrun') throw new Error('raw foreground xcrun must not run');
    return { stdout: 'Example\n', stderr: '', exitCode: 0 };
  });
  const fixture = hostFixture({ appleToolRun, commandRun, failProcessStart: true });

  await expect(
    startAppleAppLogs(
      fixture.host,
      appleDevice(),
      {
        sessionId: 'session',
        appBundleId: 'com.example.app',
        outputPath: '/tmp/app.log',
        fence: { token: 'fence', generation: 1 },
      },
      localRuntimeOwner('apple'),
    ),
  ).rejects.toThrow('start failed');

  expect(appleToolRun).toHaveBeenCalledWith(
    {
      tool: 'simctl',
      args: ['get_app_container', 'apple-1', 'com.example.app', 'app'],
      allowFailure: true,
      timeoutMs: 4_000,
    },
    undefined,
  );
  expect(commandRun).toHaveBeenCalledWith(
    {
      executable: 'plutil',
      args: ['-extract', 'CFBundleExecutable', 'raw', '-o', '-', '/tmp/Example.app/Info.plist'],
      allowFailure: true,
      timeoutMs: 4_000,
    },
    undefined,
  );
  expect(fixture.backgroundCommands[0]?.slice(0, 5)).toEqual([
    'xcrun',
    'simctl',
    'spawn',
    'apple-1',
    'log',
  ]);
});

test('simulator log stream takes the set of the device it streams from', async () => {
  const appleToolRun = vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 1 }));
  const fixture = hostFixture({ appleToolRun, failProcessStart: true });

  await expect(
    startAppleAppLogs(
      fixture.host,
      appleDevice({ simulatorSetPath: '/tmp/scoped-set' }),
      {
        sessionId: 'session',
        appBundleId: 'com.example.app',
        outputPath: '/tmp/app.log',
        fence: { token: 'fence', generation: 1 },
      },
      localRuntimeOwner('apple'),
    ),
  ).rejects.toThrow('start failed');

  expect(appleToolRun).toHaveBeenCalledWith(
    expect.objectContaining({
      args: ['--set', '/tmp/scoped-set', 'get_app_container', 'apple-1', 'com.example.app', 'app'],
    }),
    undefined,
  );
  expect(fixture.backgroundCommands[0]?.slice(0, 8)).toEqual([
    'xcrun',
    'simctl',
    '--set',
    '/tmp/scoped-set',
    'spawn',
    'apple-1',
    'log',
    'stream',
  ]);
});

test('simulator start returns only after the in-simulator stream writes output', async () => {
  const stream = launchingStream();
  const fixture = hostFixture({ startProcess: stream.start, sleep: sleepUntilAborted });

  const starting = startAppleAppLogs(
    fixture.host,
    appleDevice(),
    startInput(),
    localRuntimeOwner('apple'),
  );
  await vi.waitFor(() => expect(stream.output()).toBeDefined());
  await expect(settlesSoon(starting)).resolves.toBe(false);

  await stream.output()!.write('Filtering the log data\n');

  await expect(starting).resolves.toMatchObject({ envelope: expect.anything() });
});

test('simulator start returns when the stream exits before writing output', async () => {
  const stream = launchingStream({ exited: true });
  const fixture = hostFixture({ startProcess: stream.start, sleep: sleepUntilAborted });

  await expect(
    startAppleAppLogs(fixture.host, appleDevice(), startInput(), localRuntimeOwner('apple')),
  ).resolves.toMatchObject({ envelope: expect.anything() });
});

test('simulator start fails with a typed reason when the stream does not launch in time', async () => {
  const stream = launchingStream();
  const fixture = hostFixture({ startProcess: stream.start });

  await expect(
    startAppleAppLogs(fixture.host, appleDevice(), startInput(), localRuntimeOwner('apple')),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'simulator-log-stream-launch-timeout' },
  });
  expect(stream.disposed()).toBe(true);
  expect(fixture.outputDisposed()).toBe(true);
});

test('host log stream start does not wait for output', async () => {
  const stream = launchingStream();
  const fixture = hostFixture({ startProcess: stream.start, sleep: sleepUntilAborted });

  await expect(
    startAppleAppLogs(
      fixture.host,
      appleDevice({ appleOs: 'macos', kind: 'device' }),
      startInput(),
      localRuntimeOwner('apple'),
    ),
  ).resolves.toMatchObject({ envelope: expect.anything() });
});

test('simulator start cancelled before the stream launches terminates the process', async () => {
  const stream = launchingStream();
  const fixture = hostFixture({ startProcess: stream.start, sleep: sleepUntilAborted });
  const controller = new AbortController();
  const reason = new Error('request cancelled');

  const starting = startAppleAppLogs(
    fixture.host,
    appleDevice(),
    startInput(),
    localRuntimeOwner('apple'),
    controller.signal,
  );
  await vi.waitFor(() => expect(stream.output()).toBeDefined());
  controller.abort(reason);

  await expect(starting).rejects.toBe(reason);
  expect(stream.disposed()).toBe(true);
  expect(fixture.outputDisposed()).toBe(true);
});

function startInput() {
  return {
    sessionId: 'session',
    appBundleId: 'com.example.app',
    outputPath: '/tmp/app.log',
    fence: { token: 'fence', generation: 1 },
  };
}

function launchingStream(options: { exited?: boolean } = {}) {
  let output: AppLogOutputSink | undefined;
  let disposed = false;
  const start: AppLogRuntimeHost['processes']['start'] = async (request) => {
    output = request.output;
    return {
      wait: options.exited
        ? Promise.resolve({ stdout: '', stderr: '', exitCode: 1 })
        : new Promise<never>(() => {}),
      terminate: async () => {},
      [Symbol.asyncDispose]: async () => {
        disposed = true;
      },
    };
  };
  return { start, output: () => output, disposed: () => disposed };
}

async function sleepUntilAborted(_milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

async function settlesSoon(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let turn = 0; turn < 10; turn += 1) await new Promise((resolve) => setImmediate(resolve));
  return settled;
}
