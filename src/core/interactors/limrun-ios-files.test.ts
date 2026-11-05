import { expect, test, vi } from 'vitest';
import { fixture } from './limrun-ios-runner.fixtures.ts';
import { createLimrunAppleToolProvider } from './limrun-ios-tools.ts';
import { withAppleToolProvider } from '@agent-device/platform-apple/tool-provider';
import { resolveIosSimulatorDeepLinkBundleId } from '@agent-device/platform-apple/app-resolution';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';

const plist = (scheme: string) =>
  Buffer.from(
    `<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleExecutable</key><string>Example</string><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>${scheme}</string></array></dict></array></dict></plist>`,
  );

test('remote app metadata resolves Expo and deep-link ownership and rejects duplicate claims', async () => {
  const f = await fixture({
    containers: {
      'com.example.app': { app: { 'Info.plist': plist('exp+example') } },
      'com.example.other': { app: { 'Info.plist': plist('exp+example') } },
    },
  });
  const listApps = vi.fn(async () => [
    { bundleId: 'com.example.app', name: 'Example', installType: 'User' },
  ]);
  f.session.client.listApps = listApps;
  const provider = () => createLimrunAppleToolProvider(f.session, new AbortController().signal);
  await withAppleToolProvider(provider(), async () => {
    expect(await resolveIosSimulatorDeepLinkBundleId(f.device, 'exp+example://route')).toBe(
      'com.example.app',
    );
  });
  listApps.mockResolvedValue([
    { bundleId: 'com.example.app', name: 'Example', installType: 'User' },
    { bundleId: 'com.example.other', name: 'Other', installType: 'User' },
  ]);
  await withAppleToolProvider(provider(), async () => {
    expect(
      await resolveIosSimulatorDeepLinkBundleId(f.device, 'exp+example://route'),
    ).toBeUndefined();
  });
  expect(f.storage.calls.every((call) => call.containerType === 'app')).toBe(true);
});

test('clear state uses the shared reset and preserves container identity without launching', async () => {
  const metadata = '.com.apple.mobile_container_manager.metadata.plist';
  const f = await fixture({
    containers: {
      'com.example.app': {
        data: {
          [metadata]: Buffer.from('identity'),
          'Documents/state': Buffer.from('old'),
          'Library/Preferences/state': Buffer.from('old'),
        },
      },
      'com.example.other': { data: { 'Documents/state': Buffer.from('other app') } },
    },
  });
  f.session.client.listApps = async () => [
    { bundleId: 'com.example.app', name: 'Example', installType: 'User' },
  ];
  await withAppleToolProvider(
    createLimrunAppleToolProvider(f.session, new AbortController().signal),
    async () => {
      await f.runner.createInteractor().setSetting('clear-app-state', 'clear', 'com.example.app');
    },
  );
  expect([...f.storage.files.entries()]).toEqual([
    [`com.example.app/data/${metadata}`, Buffer.from('identity')],
    ['com.example.other/data/Documents/state', Buffer.from('other app')],
  ]);
  for (const name of ['Documents', 'Library/Caches', 'Library/Preferences', 'SystemData', 'tmp'])
    expect(f.storage.directories.has(`com.example.app/data/${name}`)).toBe(true);
  const calls = vi.mocked(f.session.client.simctl).mock.calls.map((call) => call[0]);
  expect(calls.some((args) => args[0] === 'terminate')).toBe(true);
  expect(calls.some((args) => args[0] === 'launch')).toBe(false);
  expect(
    f.storage.calls.every(
      (call) => call.bundleId === 'com.example.app' && call.containerType === 'data',
    ),
  ).toBe(true);
});

test.each([false, true])(
  'push stages the original payload and cleans up, tool failure=%s',
  async (fail) => {
    const f = await fixture({
      simctlResult: { code: fail ? 1 : 0, stdout: '', stderr: fail ? 'push rejected' : '' },
    });
    const payloadPath = path.join(f.directory, 'payload.apns');
    const payload = { aps: { alert: 'hello' }, custom: 'value' };
    const { createAppleToolHost } = await import('../../platform-runtime-apple-tool-host.ts');
    const host = {
      deviceReadiness: {
        appleAutomation: {
          wasRecentlyObservedBooted: async () => true,
          keepHot: () => {},
          markBooted: () => {},
        },
      },
      temporaryFiles: {
        create: async () => ({
          path: payloadPath,
          writeText: (text: string) => fs.writeFile(payloadPath, text),
          [Symbol.asyncDispose]: async () => fs.rm(payloadPath),
        }),
      },
      appleTools: createAppleToolHost(),
    } as unknown as PlatformRuntimeHost;
    // The real runner binding scopes the host tools and the staged file to the same instance.
    const operations = f.runner.bindDeployment({
      host,
      signal: new AbortController().signal,
      install: async () => ({}),
    });
    const send = operations.sendPushNotification!;
    const sent = send({ appId: 'com.example.app', payload });
    if (fail) await expect(sent).rejects.toMatchObject({ code: 'COMMAND_FAILED' });
    else await sent;
    const upload = f.storage.calls.find((call) => call.method === 'PUT')!;
    expect(JSON.parse(upload.body.toString())).toEqual(payload);
    expect(vi.mocked(f.session.client.simctl).mock.calls[0]?.[0]).toEqual([
      'push',
      'booted',
      'com.example.app',
      `/staging/${upload.name}`,
    ]);
    expect(f.storage.files.has(`staging/${upload.name}`)).toBe(false);
    expect(
      f.storage.calls.some((call) => call.method === 'DELETE' && call.name === upload.name),
    ).toBe(true);
  },
);

test('binary installed metadata uses shared Expo launch hints and explicit URL precedence', async () => {
  const f = await fixture({
    containers: {
      'com.example.app': {
        app: {
          'Info.plist': Buffer.from(
            'YnBsaXN0MDDSAQIDBF8QEkNGQnVuZGxlRXhlY3V0YWJsZV8QEENGQnVuZGxlVVJMVHlwZXNXRXhhbXBsZaEF0QYHXxASQ0ZCdW5kbGVVUkxTY2hlbWVzoQhbZXhwK2V4YW1wbGUIDSI1PT9CV1kAAAAAAAABAQAAAAAAAAAJAAAAAAAAAAAAAAAAAAAAZQ==',
            'base64',
          ),
        },
      },
    },
  });
  f.session.client.listApps = async () => [
    { bundleId: 'com.example.app', name: 'Example', installType: 'User' },
  ];
  const lifecycle = f.runner.bindApplicationLifecycle({
    signal: new AbortController().signal,
    clock: { now: Date.now, sleep: async () => {} },
    resolveInteractor: async (_device, context) => f.runner.createInteractor(context),
  });
  const input = {
    target: 'com.example.app',
    positionals: ['com.example.app'],
    appBundleId: 'com.example.app',
    surface: 'app' as const,
    hasExistingSession: true,
    relaunch: false,
    prewarmRunnerBeforeOpen: false,
    enableTestIme: false,
    stateDir: f.directory,
    runtimeHints: { metroHost: 'localhost', metroPort: '8081' },
    execution: {},
    applyRuntimeHints: async () => {},
  };
  expect(await lifecycle.openApplication(input)).toMatchObject({ appBundleId: 'com.example.app' });
  expect(vi.mocked(f.session.client.simctl).mock.calls.map(([args]) => args)).toContainEqual([
    'openurl',
    'booted',
    'exp+example://expo-development-client/?url=http%3A%2F%2Flocalhost%3A8081',
  ]);
  await lifecycle.openApplication({ ...input, runtimeLaunchUrl: 'custom://explicit' });
  const urls = vi
    .mocked(f.session.client.simctl)
    .mock.calls.map(([args]) => args)
    .filter((args) => args[0] === 'openurl');
  expect(urls.at(-1)).toEqual(['openurl', 'booted', 'custom://explicit']);
});

test.each([
  { state: 'clear', app: undefined },
  { state: 'wipe', app: 'com.example.app' },
])('clear state rejects invalid input before modifying files: %j', async ({ state, app }) => {
  const f = await fixture();
  await withAppleToolProvider(
    createLimrunAppleToolProvider(f.session, new AbortController().signal),
    async () => {
      await expect(
        f.runner.createInteractor().setSetting('clear-app-state', state, app),
      ).rejects.toMatchObject({ code: 'INVALID_ARGS' });
    },
  );
  expect(f.storage.calls).toEqual([]);
});

test('staged payload cleanup survives cancellation of its command', async () => {
  const f = await fixture();
  const cancellation = new AbortController();
  const provider = createLimrunAppleToolProvider(
    f.session,
    new AbortController().signal,
    cancellation.signal,
  );
  const payload = path.join(f.directory, 'canceled.apns');
  await fs.writeFile(payload, '{}');
  const staged = await provider.simulatorFiles!.stageFile!(payload, cancellation.signal);
  cancellation.abort(new Error('cancel'));
  await staged[Symbol.asyncDispose]();
  expect(f.storage.files.size).toBe(0);
});

test('clear state reports file deletion failure without relaunching or recreating directories', async () => {
  const f = await fixture({
    containers: { 'com.example.app': { data: { 'Documents/state': Buffer.from('old') } } },
    failFileMethod: 'DELETE',
  });
  f.session.client.listApps = async () => [
    { bundleId: 'com.example.app', name: 'Example', installType: 'User' },
  ];
  await withAppleToolProvider(
    createLimrunAppleToolProvider(f.session, new AbortController().signal),
    async () => {
      await expect(
        f.runner.createInteractor().setSetting('clear-app-state', 'clear', 'com.example.app'),
      ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { status: 500 } });
    },
  );
  expect(f.storage.calls.some((call) => call.method === 'PUT')).toBe(false);
  expect(
    vi.mocked(f.session.client.simctl).mock.calls.some((call) => call[0][0] === 'launch'),
  ).toBe(false);
});

test('clear state reports the shared no-data-container result without mutating files', async () => {
  const f = await fixture({ failFileMethod: 'GET', failFileStatus: 404 });
  await withAppleToolProvider(
    createLimrunAppleToolProvider(f.session, new AbortController().signal),
    async () => {
      await expect(
        f.runner.createInteractor().setSetting('clear-app-state', 'clear', 'com.apple.Preferences'),
      ).rejects.toMatchObject({
        code: 'UNSUPPORTED_OPERATION',
        details: { reason: 'app-no-data-container', appBundleId: 'com.apple.Preferences' },
      });
    },
  );
  expect(f.storage.calls.map((call) => call.method)).toEqual(['GET']);
});

test('deep-link ownership ignores missing metadata for another installed app', async () => {
  const f = await fixture({
    containers: { 'com.example.app': { app: { 'Info.plist': plist('exp+example') } } },
  });
  f.session.client.listApps = async () => [
    { bundleId: 'com.example.absent', name: 'Missing metadata', installType: 'User' },
    { bundleId: 'com.example.app', name: 'Example', installType: 'User' },
  ];
  await withAppleToolProvider(
    createLimrunAppleToolProvider(f.session, new AbortController().signal),
    async () => {
      expect(await resolveIosSimulatorDeepLinkBundleId(f.device, 'exp+example://route')).toBe(
        'com.example.app',
      );
    },
  );
});

test.each([401, 500])('app metadata HTTP %s is not treated as an absent plist', async (status) => {
  const f = await fixture({ failFileMethod: 'GET', failFileStatus: status });
  const tools = createLimrunAppleToolProvider(f.session, new AbortController().signal);
  await expect(
    tools.simulatorApps.readInfoPlist({
      device: f.device,
      bundleId: 'com.example.app',
      timeoutMs: 1000,
    }),
  ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { statusCode: status } });
});

test('container operations receive fresh deadlines after earlier operations have completed', async () => {
  const f = await fixture({
    containers: { 'com.example.app': { data: { 'Documents/state': Buffer.from('old') } } },
  });
  const deadlines: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const deadline = new AbortController();
    deadlines.push(deadline);
    return deadline.signal;
  });
  const expireCompletedOperations = () => {
    for (const deadline of deadlines)
      deadline.abort(new DOMException('deadline expired', 'TimeoutError'));
  };
  try {
    const tools = createLimrunAppleToolProvider(f.session, new AbortController().signal);
    const container = await tools.simulatorFiles.openContainer({
      device: f.device,
      bundleId: 'com.example.app',
      containerType: 'data',
      timeoutMs: 1000,
    });
    expect(container).not.toBeNull();
    expireCompletedOperations();
    expect(await container!.list()).toEqual(['Documents']);
    expireCompletedOperations();
    await container!.remove('Documents');
    expireCompletedOperations();
    await container!.ensureDirectory('Library/Caches');
    expect(f.storage.files.size).toBe(0);
    expect(f.storage.directories.has('com.example.app/data/Library/Caches')).toBe(true);
  } finally {
    timeout.mockRestore();
  }
});

test('a container download deadline remains a typed timeout and removes the partial artifact', async () => {
  const deadline = new AbortController();
  const f = await fixture({
    containers: { 'com.example.app': { data: { 'tmp/large.bin': Buffer.from('partial') } } },
    holdFileDownload: true,
    onFileDownload: () => deadline.abort(new DOMException('deadline expired', 'TimeoutError')),
  });
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
  const destinationPath = path.join(f.directory, 'timed-out.bin');
  try {
    const tools = createLimrunAppleToolProvider(f.session, new AbortController().signal);
    await expect(
      tools.simulatorFiles.copyToHost({
        device: f.device,
        bundleId: 'com.example.app',
        containerType: 'data',
        sourcePath: 'tmp/large.bin',
        destinationPath,
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({ code: 'COMMAND_FAILED', details: { timeoutMs: 1000 } });
    await expect(fs.stat(destinationPath)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    timeout.mockRestore();
  }
});

test('a failed upload reply removes the staged file before rejecting', async () => {
  const f = await fixture({ invalidUploadReply: true });
  const local = path.join(f.directory, 'push.apns');
  await fs.writeFile(local, '{}');
  const tools = createLimrunAppleToolProvider(f.session, new AbortController().signal);
  await expect(tools.simulatorFiles.stageFile(local)).rejects.toThrow();
  expect([...f.storage.files.keys()]).toEqual([]);
  expect(f.storage.calls.map((call) => call.method)).toEqual(['PUT', 'DELETE']);
});

test('concurrent metadata reads do not inherit another caller cancellation', async () => {
  const f = await fixture({
    holdFileDownload: true,
    containers: { 'com.example.app': { app: { 'Info.plist': plist('exp+example') } } },
  });
  const tools = createLimrunAppleToolProvider(f.session, new AbortController().signal);
  const canceled = new AbortController();
  const input = { device: f.device, bundleId: 'com.example.app', timeoutMs: 5000 };
  const first = tools.simulatorApps.readInfoPlist({ ...input, signal: canceled.signal });
  const failed = expect(first).rejects.toMatchObject({ details: { reason: 'request_canceled' } });
  const second = tools.simulatorApps.readInfoPlist(input);
  await vi.waitFor(() =>
    expect(f.storage.calls.filter((call) => call.method === 'GET')).toHaveLength(2),
  );
  canceled.abort();
  await failed;
  f.storage.finishDownloads();
  await expect(second).resolves.toMatchObject({ CFBundleExecutable: 'Example' });
});
