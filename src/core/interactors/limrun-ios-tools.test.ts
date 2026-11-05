import { SimctlExecution } from '@limrun/api/ios-client';
import { buildSimctlArgsForDevice } from '@agent-device/platform-apple/simctl';
import { runXcrun, withAppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import { createLimrunAppleToolProvider } from './limrun-ios-tools.ts';
import { expect, test, vi } from 'vitest';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { AppError } from '@agent-device/kernel/errors';
import { fixture } from './limrun-ios-runner.fixtures.ts';

async function sessionWithClient(result = { code: 0, stdout: '', stderr: '' }) {
  const f = await fixture({ simctlResult: result });
  return {
    ...f,
    interactor: f.runner.createInteractor(),
    simctl: vi.mocked(f.session.client.simctl),
  };
}

test('malformed successful device inventory preserves the remote command output', async () => {
  const f = await sessionWithClient();
  const execution = new SimctlExecution(() => {});
  vi.spyOn(execution, 'wait').mockResolvedValue({
    code: 0,
    stdout: 'not JSON',
    stderr: 'simulator warning',
  });
  f.simctl.mockReturnValue(execution);
  const tools = createLimrunAppleToolProvider(f.session, new AbortController().signal);
  await expect(
    withAppleToolProvider(tools, () =>
      runXcrun(buildSimctlArgsForDevice(f.device, ['list', 'devices', '--json'])),
    ),
  ).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: {
      cmd: 'simctl',
      args: ['list', 'devices', '--json'],
      stdout: 'not JSON',
      stderr: 'simulator warning',
    },
  });
});

test('launch arguments and explicit relaunch use the shared simctl launch', async () => {
  const { interactor, simctl } = await sessionWithClient();
  await interactor.open('com.example.app', {
    launchArgs: ['--flag', 'value'],
    terminateRunningApp: true,
  });
  expect(simctl).toHaveBeenCalledWith(
    ['launch', '--terminate-running-process', 'booted', 'com.example.app', '--flag', 'value'],
    undefined,
  );
});

test('normal launch uses the same simctl path as local', async () => {
  const { interactor, simctl } = await sessionWithClient();
  await interactor.open('com.example.app');
  expect(simctl).toHaveBeenCalledWith(['launch', 'booted', 'com.example.app'], undefined);
});

test('a url open launches with arguments before opening the url', async () => {
  const { interactor, simctl } = await sessionWithClient();
  await interactor.open('com.example.app', {
    url: 'myapp://home',
    launchArgs: ['--flag', 'value'],
  });
  const calls = simctl.mock.calls.map((call) => call[0]);
  expect(calls).toContainEqual(['launch', 'booted', 'com.example.app', '--flag', 'value']);
  expect(calls).toContainEqual(['openurl', 'booted', 'myapp://home']);
  expect(calls.findIndex((args) => args[0] === 'launch')).toBeLessThan(
    calls.findIndex((args) => args[0] === 'openurl'),
  );
});

test('a failed launch preserves exit code and stderr through the shared error path', async () => {
  const { interactor, simctl } = await sessionWithClient({
    code: 1,
    stdout: '',
    stderr: 'launch failed\n',
  });
  const error = await interactor
    .open('com.example.app', { launchArgs: ['--flag'] })
    .catch((error) => error);
  expect(error).toBeInstanceOf(AppError);
  expect(error).toMatchObject({
    code: 'COMMAND_FAILED',
    details: { exitCode: 1, stderr: 'launch failed\n' },
  });
  expect(simctl.mock.calls.some((call) => call[0][0] === 'openurl')).toBe(false);
});

test('explicit relaunch uses the resolved bundle ID', async () => {
  const { interactor, simctl } = await sessionWithClient();
  await interactor.open('Settings', {
    appBundleId: 'com.apple.Preferences',
    terminateRunningApp: true,
  });
  expect(simctl).toHaveBeenCalledWith(
    ['launch', '--terminate-running-process', 'booted', 'com.apple.Preferences'],
    undefined,
  );
});

test('launch console writes remote process output through the local capture implementation', async () => {
  const { interactor, simctl, directory } = await sessionWithClient({
    code: 0,
    stdout: 'app says hello\n',
    stderr: 'app warning\n',
  });
  const logPath = path.join(directory, 'app.log');
  await interactor.open('com.example.app', { launchConsole: logPath });
  expect(simctl).toHaveBeenCalledWith(
    ['launch', '--console-pty', 'booted', 'com.example.app'],
    undefined,
  );
  expect(await fs.readFile(logPath, 'utf8')).toContain('app says hello\napp warning\n');
});

test('shared target resolution matches installed app display names', async () => {
  const { runner, device } = await sessionWithClient();
  expect(
    await runner.applicationTools.resolveOpenTarget(device, { target: 'Settings', surface: 'app' }),
  ).toMatchObject({ appBundleId: 'com.apple.Preferences' });
});

test('runtime hints write and clear the same native defaults as local', async () => {
  const { runner, device, simctl } = await sessionWithClient();
  await runner.applicationTools.applyRuntimeHints(device, {
    appId: 'com.example.app',
    values: { metroHost: 'dev.example', metroPort: '8081' },
  });
  expect(simctl).toHaveBeenCalledWith(
    [
      'spawn',
      'booted',
      'defaults',
      'write',
      'com.example.app',
      'RCT_jsLocation',
      '-string',
      'dev.example:8081',
    ],
    undefined,
  );
  expect(simctl).toHaveBeenCalledWith(
    [
      'spawn',
      'booted',
      'defaults',
      'write',
      'com.example.app',
      'RCT_packager_scheme',
      '-string',
      'http',
    ],
    undefined,
  );
  await runner.applicationTools.clearRuntimeHints(device, { appId: 'com.example.app', values: {} });
  expect(simctl).toHaveBeenCalledWith(
    ['spawn', 'booted', 'defaults', 'delete', 'com.example.app', 'RCT_jsLocation'],
    undefined,
  );
});

test('reads the pasteboard through shared simctl pbpaste and normalizes line endings', async () => {
  const f = await fixture({ simctlResult: { code: 0, stdout: 'first\r\nsecond\n', stderr: '' } });
  await expect(f.runner.createInteractor().readClipboard!()).resolves.toBe('first\nsecond');
  expect(vi.mocked(f.session.client.simctl)).toHaveBeenCalledWith(['pbpaste', 'booted'], undefined);
});

test('a failed pasteboard read preserves command failure evidence', async () => {
  const f = await fixture({ simctlResult: { code: 1, stdout: '', stderr: 'pbpaste: refused\n' } });
  await expect(f.runner.createInteractor().readClipboard!()).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { exitCode: 1, stderr: 'pbpaste: refused\n' },
  });
});

test('a host timeout stops the remote command and preserves partial console output', async () => {
  const f = await fixture();
  const stopped = vi.fn();
  const execution = new SimctlExecution(stopped);
  vi.mocked(f.session.client.simctl).mockReturnValue(execution);
  const tools = createLimrunAppleToolProvider(f.session, new AbortController().signal);
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  try {
    const pending = tools.runCommand(
      'xcrun',
      ['simctl', 'launch', f.device.id, 'com.example.app'],
      { timeoutMs: 10 },
    );
    const outcome = expect(pending).rejects.toMatchObject({
      details: { timeoutMs: 10, stdout: 'before timeout\n', stderr: 'warning\n' },
    });
    execution.emit('stdout', Buffer.from('before timeout\n'));
    execution.emit('stderr', Buffer.from('warning\n'));
    deadline.abort();
    await outcome;
    expect(stopped).toHaveBeenCalledOnce();
    expect(execution.listenerCount('stdout')).toBe(0);
  } finally {
    timeout.mockRestore();
  }
});

for (const canceledBy of ['lease', 'deadline'] as const) {
  test(`cleanup ignores the canceled request but still stops at its ${canceledBy}`, async () => {
    const f = await fixture();
    const stopped = vi.fn();
    vi.mocked(f.session.client.simctl).mockReturnValue(new SimctlExecution(stopped));
    const lease = new AbortController();
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    try {
      const tools = createLimrunAppleToolProvider(f.session, lease.signal, AbortSignal.abort());
      const pending = tools.runCommand('xcrun', ['simctl', 'status_bar', f.device.id, 'clear'], {
        requestCancellation: 'ignore',
        timeoutMs: 30_000,
      });
      const outcome = expect(pending).rejects.toMatchObject({
        details: canceledBy === 'deadline' ? { timeoutMs: 30_000 } : { reason: 'request_canceled' },
      });
      expect(stopped).not.toHaveBeenCalled();
      (canceledBy === 'lease' ? lease : deadline).abort();
      await outcome;
      expect(stopped).toHaveBeenCalledOnce();
    } finally {
      timeout.mockRestore();
    }
  });
}

test('canceling an app catalog request releases the caller without waiting for the server', async () => {
  const f = await fixture();
  vi.spyOn(f.session.client, 'listApps').mockImplementation(() => new Promise(() => {}));
  const abort = new AbortController();
  const tools = createLimrunAppleToolProvider(
    f.session,
    new AbortController().signal,
    abort.signal,
  );
  const pending = tools.runCommand('xcrun', ['simctl', 'listapps', f.device.id]);
  const outcome = expect(pending).rejects.toMatchObject({
    details: { reason: 'request_canceled' },
  });
  abort.abort();
  await outcome;
});

test('canceling a lifecycle runtime-hint command stops the remote defaults process', async () => {
  const f = await fixture();
  const stop = vi.fn();
  vi.mocked(f.session.client.simctl).mockReturnValue(new SimctlExecution(stop));
  const controller = new AbortController();
  const lifecycle = f.runner.bindApplicationLifecycle({
    signal: controller.signal,
    clock: { now: Date.now, sleep: async () => {} },
    resolveInteractor: async () => f.runner.createInteractor(),
  });
  const pending = lifecycle.applyRuntimeHints({
    appId: 'com.example.app',
    values: { metroHost: 'parity.example', metroPort: '8081' },
  });
  const outcome = expect(pending).rejects.toMatchObject({
    details: { reason: 'request_canceled' },
  });
  await vi.waitFor(() => expect(f.session.client.simctl).toHaveBeenCalled());
  controller.abort();
  await outcome;
  expect(stop).toHaveBeenCalledOnce();
});

test.each(['app', 'data', 'group.com.example.shared'])(
  'downloads a file from a %s container through the authenticated host transport',
  async (containerType) => {
    const sourcePath = 'Documents/a file #1.bin';
    const bytes = Buffer.from([0, 1, 128, 255]);
    const f = await fixture({
      containers: { 'com.example.app': { [containerType]: { [sourcePath]: bytes } } },
    });
    const tools = createLimrunAppleToolProvider(f.session, new AbortController().signal);
    const destinationPath = path.join(f.directory, 'download', 'file.bin');
    await tools.simulatorFiles!.copyToHost({
      device: f.device,
      bundleId: 'com.example.app',
      containerType,
      sourcePath,
      destinationPath,
      timeoutMs: 1000,
    });
    expect(await fs.readFile(destinationPath)).toEqual(bytes);
    const url = new URL(f.requests.at(-1)!, 'http://fixture');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      name: sourcePath,
      bundleId: 'com.example.app',
      containerType,
    });
  },
);

test('a missing container file reports HTTP failure and leaves no local artifact', async () => {
  const f = await fixture();
  const tools = createLimrunAppleToolProvider(f.session, new AbortController().signal);
  const destinationPath = path.join(f.directory, 'missing.bin');
  await expect(
    tools.simulatorFiles!.copyToHost({
      device: f.device,
      bundleId: 'com.example.app',
      containerType: 'data',
      sourcePath: 'Documents/missing.bin',
      destinationPath,
      timeoutMs: 1000,
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { statusCode: 404 } });
  await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test('canceling a container download stops the transfer and removes the partial artifact', async () => {
  let markStarted = () => {};
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const f = await fixture({
    containers: { 'com.example.app': { data: { 'tmp/large.bin': Buffer.from('partial') } } },
    holdFileDownload: true,
    onFileDownload: markStarted,
  });
  const controller = new AbortController();
  const tools = createLimrunAppleToolProvider(
    f.session,
    new AbortController().signal,
    controller.signal,
  );
  const destinationPath = path.join(f.directory, 'canceled.bin');
  const pending = tools.simulatorFiles!.copyToHost({
    device: f.device,
    bundleId: 'com.example.app',
    containerType: 'data',
    sourcePath: 'tmp/large.bin',
    destinationPath,
    timeoutMs: 1000,
  });
  const reason = new Error('request canceled');
  const outcome = expect(pending).rejects.toMatchObject({
    code: 'COMMAND_FAILED',
    details: { reason: 'request_canceled' },
  });
  await started;
  controller.abort(reason);
  await outcome;
  await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
});

test.each(['timeout', 'request'] as const)(
  'app discovery distinguishes a %s abort without falling through to a local tool',
  async (source) => {
    const f = await fixture();
    const deadline = new AbortController();
    const request = new AbortController();
    let started!: () => void;
    const listing = new Promise<void>((resolve) => {
      started = resolve;
    });
    let complete!: (apps: []) => void;
    f.session.client.listApps = vi.fn(() => {
      started();
      return new Promise<[]>((resolve) => {
        complete = resolve;
      });
    });
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    const tools = createLimrunAppleToolProvider(
      f.session,
      new AbortController().signal,
      request.signal,
    );
    try {
      const { withAppleToolProvider } = await import('@agent-device/platform-apple/tool-provider');
      const { resolveIosSimulatorDeepLinkBundleId } =
        await import('@agent-device/platform-apple/app-resolution');
      const pending = withAppleToolProvider(tools, () =>
        resolveIosSimulatorDeepLinkBundleId(f.device, 'example://route', { timeoutMs: 1000 }),
      );
      const outcome = expect(pending).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof AppError &&
          error.code === 'COMMAND_FAILED' &&
          (source === 'timeout'
            ? error.details?.timeoutMs !== undefined && error.details?.reason !== 'request_canceled'
            : error.details?.reason === 'request_canceled'),
      );
      await listing;
      (source === 'timeout' ? deadline : request).abort();
      await outcome;
      expect(f.session.client.simctl).not.toHaveBeenCalled();
    } finally {
      complete([]);
      timeout.mockRestore();
    }
  },
);

test.each([
  ['list', '-j'],
  ['list', '--json'],
  ['list', 'devices', '--json'],
])('normalizes the remote device identity for %j', async (...args) => {
  const f = await fixture();
  const tools = createLimrunAppleToolProvider(f.session, new AbortController().signal);
  const result = await tools.runCommand('xcrun', ['simctl', ...args], {});
  const inventory = JSON.parse(result.stdout);
  expect(inventory.devices.ios[0].udid).toBe(f.device.id);
});
