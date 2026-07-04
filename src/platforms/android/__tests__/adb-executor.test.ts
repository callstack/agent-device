import assert from 'node:assert/strict';
import { test, vi } from 'vitest';

const { runCmdBackgroundMock } = vi.hoisted(() => ({
  runCmdBackgroundMock: vi.fn(() => ({
    child: {},
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  })),
}));

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return {
    ...actual,
    runCmd: vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 })),
    runCmdBackground: runCmdBackgroundMock,
  };
});

import {
  androidAdbResultError,
  attachAdbFailureHint,
  classifyAdbFailure,
  createAndroidPortReverseManager,
  createDeviceAdbExecutor,
  createLocalAndroidAdbProvider,
  installAndroidAdbPackage,
  pullAndroidAdbFile,
  resolveAndroidAdbExecutor,
  resolveAndroidAdbProvider,
  withAndroidAdbProvider,
} from '../adb-executor.ts';
import { runCmd, runCmdBackground } from '../../../utils/exec.ts';
import { AppError, normalizeError } from '../../../kernel/errors.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockRunCmdBackground = vi.mocked(runCmdBackground);
const localAdbExecOptions = { detached: process.platform !== 'win32' };

test('createDeviceAdbExecutor routes local commands through adb with the device serial', async () => {
  const adb = createDeviceAdbExecutor({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel Emulator',
    kind: 'emulator',
    booted: true,
  });

  const result = await adb(['shell', 'getprop', 'sys.boot_completed'], { timeoutMs: 1000 });

  assert.deepEqual(result, { stdout: 'ok', stderr: '', exitCode: 0 });
  assert.deepEqual(mockRunCmd.mock.calls, [
    [
      'adb',
      ['-s', 'emulator-5554', 'shell', 'getprop', 'sys.boot_completed'],
      { timeoutMs: 1000, ...localAdbExecOptions },
    ],
  ]);
});

test('createDeviceAdbExecutor remains a local adb executor inside provider scopes', async () => {
  mockRunCmd.mockClear();
  const providerCalls: string[][] = [];
  const adb = createDeviceAdbExecutor({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel Emulator',
    kind: 'emulator',
    booted: true,
  });

  const result = await withAndroidAdbProvider(
    async (args) => {
      providerCalls.push(args);
      return { stdout: 'provider', stderr: '', exitCode: 0 };
    },
    { serial: 'emulator-5554' },
    async () => await adb(['shell', 'echo', 'local']),
  );

  assert.equal(result.stdout, 'ok');
  assert.deepEqual(providerCalls, []);
  assert.deepEqual(mockRunCmd.mock.calls, [
    ['adb', ['-s', 'emulator-5554', 'shell', 'echo', 'local'], localAdbExecOptions],
  ]);
});

test('scoped provider only resolves for the matching device serial', async () => {
  mockRunCmd.mockClear();
  const providerCalls: string[][] = [];
  const otherDevice = {
    platform: 'android',
    id: 'other-device',
    name: 'Other Android',
    kind: 'device',
    booted: true,
  } as const;

  const result = await withAndroidAdbProvider(
    async (args) => {
      providerCalls.push(args);
      return { stdout: 'provider', stderr: '', exitCode: 0 };
    },
    { serial: 'emulator-5554' },
    async () => {
      const adb = resolveAndroidAdbExecutor(otherDevice);
      const provider = resolveAndroidAdbProvider(otherDevice);
      await provider.exec(['shell', 'echo', 'provider-fallback']);
      return await adb(['shell', 'echo', 'executor-fallback']);
    },
  );

  assert.equal(result.stdout, 'ok');
  assert.deepEqual(providerCalls, []);
  assert.deepEqual(
    mockRunCmd.mock.calls.map((call) => call[1]),
    [
      ['-s', 'other-device', 'shell', 'echo', 'provider-fallback'],
      ['-s', 'other-device', 'shell', 'echo', 'executor-fallback'],
    ],
  );
});

test('createLocalAndroidAdbProvider exposes exec, spawn, and reverse over local adb', async () => {
  mockRunCmd.mockClear();
  mockRunCmdBackground.mockClear();
  const provider = createLocalAndroidAdbProvider({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel Emulator',
    kind: 'emulator',
    booted: true,
  });

  await provider.exec(['shell', 'echo', 'ok']);
  provider.spawn?.(['logcat'], { stdio: ['ignore', 'pipe', 'pipe'] });
  await provider.reverse?.ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'session-a' });
  await provider.reverse?.removeAllOwned('session-a');

  assert.deepEqual(mockRunCmdBackground.mock.calls, [
    [
      'adb',
      ['-s', 'emulator-5554', 'logcat'],
      { stdio: ['ignore', 'pipe', 'pipe'], allowFailure: true, captureOutput: false },
    ],
  ]);
  assert.deepEqual(
    mockRunCmd.mock.calls.map((call) => call[1]),
    [
      ['-s', 'emulator-5554', 'shell', 'echo', 'ok'],
      ['-s', 'emulator-5554', 'reverse', 'tcp:8081', 'tcp:8081'],
      ['-s', 'emulator-5554', 'reverse', '--remove', 'tcp:8081'],
    ],
  );
});

test('createLocalAndroidAdbProvider exposes local pull and install capabilities', async () => {
  mockRunCmd.mockClear();
  const provider = createLocalAndroidAdbProvider({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel Emulator',
    kind: 'emulator',
    booted: true,
  });

  await provider.pull?.('/sdcard/video.mp4', '/tmp/video.mp4', { allowFailure: true });
  await provider.install?.('/tmp/app.apk', {
    allowDowngrade: true,
    allowTestPackages: true,
    grantPermissions: true,
    replace: true,
    timeoutMs: 2000,
  });

  assert.deepEqual(mockRunCmd.mock.calls, [
    [
      'adb',
      ['-s', 'emulator-5554', 'pull', '/sdcard/video.mp4', '/tmp/video.mp4'],
      { allowFailure: true, ...localAdbExecOptions },
    ],
    [
      'adb',
      ['-s', 'emulator-5554', 'install', '-r', '-t', '-d', '-g', '/tmp/app.apk'],
      { timeoutMs: 2000, ...localAdbExecOptions },
    ],
  ]);
});

test('createAndroidPortReverseManager makes duplicate setup idempotent and cleans owner mappings', async () => {
  const calls: string[][] = [];
  const manager = createAndroidPortReverseManager(async (args) => {
    calls.push(args);
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await manager.ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'session-a' });
  await manager.ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'session-a' });
  await manager.ensure({ local: 'tcp:8082', remote: 'tcp:8081', ownerId: 'session-a' });
  await manager.removeAllOwned('session-a');

  assert.deepEqual(calls, [
    ['reverse', 'tcp:8081', 'tcp:8081'],
    ['reverse', 'tcp:8082', 'tcp:8081'],
    ['reverse', '--remove', 'tcp:8081'],
    ['reverse', '--remove', 'tcp:8082'],
  ]);
});

test('createAndroidPortReverseManager rejects mappings owned by another session', async () => {
  const manager = createAndroidPortReverseManager(async () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
  }));

  await manager.ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'session-a' });
  await assert.rejects(
    () => manager.ensure({ local: 'tcp:8081', remote: 'tcp:8082', ownerId: 'session-b' }),
    /already owned by session-a/,
  );
});

test('createAndroidPortReverseManager lists parsed reverse mappings with owners', async () => {
  const manager = createAndroidPortReverseManager(async (args) => {
    if (args.join(' ') === 'reverse --list') {
      return {
        stdout: [
          'emulator-5554 tcp:8081 tcp:8081',
          'emulator-5554 localabstract:metro tcp:9090',
          '',
        ].join('\n'),
        stderr: '',
        exitCode: 0,
      };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await manager.ensure({ local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'session-a' });
  const mappings = await manager.list?.();

  assert.deepEqual(mappings, [
    { local: 'tcp:8081', remote: 'tcp:8081', ownerId: 'session-a' },
    { local: 'localabstract:metro', remote: 'tcp:9090', ownerId: undefined },
  ]);
});

test('resolveAndroidAdbProvider does not infer reverse support for plain executors', () => {
  const provider = resolveAndroidAdbProvider(
    {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel Emulator',
      kind: 'emulator',
      booted: true,
    },
    async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  );

  assert.equal(provider.reverse, undefined);
});

test('explicit transfer helpers prefer provider capabilities over exec-shaped fallback', async () => {
  const calls: string[] = [];

  await withAndroidAdbProvider(
    {
      exec: async (args) => {
        calls.push(`exec:${args.join(' ')}`);
        return { stdout: 'exec', stderr: '', exitCode: 0 };
      },
      pull: async (remotePath, localPath) => {
        calls.push(`pull:${remotePath}:${localPath}`);
        return { stdout: 'pull', stderr: '', exitCode: 0 };
      },
      install: async (source, options) => {
        calls.push(`install:${String(source)}:${options?.replace === true}`);
        return { stdout: 'install', stderr: '', exitCode: 0 };
      },
    },
    { serial: 'emulator-5554' },
    async () => {
      await pullAndroidAdbFile('/remote.mp4', '/local.mp4');
      await installAndroidAdbPackage('/app.apk', { replace: true });
    },
  );

  assert.deepEqual(calls, ['pull:/remote.mp4:/local.mp4', 'install:/app.apk:true']);
});

test('explicit transfer helpers keep exec-shaped fallback for older providers', async () => {
  const calls: string[][] = [];

  await withAndroidAdbProvider(
    async (args) => {
      calls.push(args);
      return { stdout: 'ok', stderr: '', exitCode: 0 };
    },
    { serial: 'emulator-5554' },
    async () => {
      await pullAndroidAdbFile('/remote.mp4', '/local.mp4');
      await installAndroidAdbPackage('/app.apk', { replace: true });
    },
  );

  assert.deepEqual(calls, [
    ['pull', '/remote.mp4', '/local.mp4'],
    ['install', '-r', '/app.apk'],
  ]);
});

test('classifyAdbFailure recognizes the common adb failure families', () => {
  const cases: Array<[stderr: string, reason: string, retriable: boolean | undefined]> = [
    ['adb: device offline', 'device_offline', true],
    [
      "error: device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set",
      'device_unauthorized',
      undefined,
    ],
    ['adb: more than one device/emulator', 'multiple_devices', undefined],
    ['error: more than one device and emulator', 'multiple_devices', undefined],
    ['error: no devices/emulators found', 'no_devices', undefined],
    ["error: device 'emulator-5554' not found", 'device_not_found', true],
    ['error: device not found', 'device_not_found', true],
    [
      "adb server version (40) doesn't match this client (41); killing...",
      'server_version_mismatch',
      true,
    ],
    [
      "error: protocol fault (couldn't read status): Connection reset by peer",
      'connection_dropped',
      true,
    ],
    ['error: transport error', 'connection_dropped', true],
    [
      'adb: failed to install app.apk: Failure [INSTALL_FAILED_INSUFFICIENT_STORAGE]',
      'install_insufficient_storage',
      undefined,
    ],
    [
      'adb: failed to install app.apk: Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]',
      'install_update_incompatible',
      undefined,
    ],
    [
      'adb: failed to install app.apk: Failure [INSTALL_FAILED_VERSION_DOWNGRADE]',
      'install_version_downgrade',
      undefined,
    ],
    [
      'adb: failed to install app.apk: Failure [INSTALL_FAILED_NO_MATCHING_ABIS]',
      'install_failed',
      undefined,
    ],
  ];
  for (const [stderr, reason, retriable] of cases) {
    const classification = classifyAdbFailure(stderr);
    assert.equal(classification?.reason, reason, `reason for: ${stderr}`);
    assert.equal(classification?.retriable, retriable, `retriable for: ${stderr}`);
    assert.ok((classification?.hint ?? '').length > 0, `hint for: ${stderr}`);
  }
});

test('classifyAdbFailure matches install verdicts on stdout but transport families only on stderr', () => {
  const installFromStdout = classifyAdbFailure('', 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE]');
  assert.equal(installFromStdout?.reason, 'install_update_incompatible');
  // Arbitrary `adb shell` stdout (e.g. cat-ing a log) must not read as a transport failure.
  assert.equal(classifyAdbFailure('', 'log line: device offline detected'), undefined);
  assert.equal(classifyAdbFailure('unrelated failure output'), undefined);
});

test('the local adb executor attaches classified hints to thrown command failures', async () => {
  mockRunCmd.mockClear();
  mockRunCmd.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'adb exited with code 1', {
      cmd: 'adb',
      exitCode: 1,
      stdout: '',
      stderr: "error: device unauthorized.\nThis adb server's $ADB_VENDOR_KEYS is not set",
      processExitError: true,
    }),
  );
  const adb = createDeviceAdbExecutor({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel Emulator',
    kind: 'emulator',
    booted: true,
  });

  const error = await adb(['shell', 'echo', 'hi']).then(
    () => assert.fail('expected the adb call to reject'),
    (err: unknown) => err,
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.adbFailure, 'device_unauthorized');
  assert.match(String(error.details?.hint), /authorization prompt/i);
  assert.equal(Object.hasOwn(error.details ?? {}, 'retriable'), false);
});

test('the local adb executor flags transient transport failures retriable', async () => {
  mockRunCmd.mockClear();
  mockRunCmd.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'adb exited with code 1', {
      exitCode: 1,
      stdout: '',
      stderr: 'adb: device offline',
      processExitError: true,
    }),
  );
  const adb = createDeviceAdbExecutor({
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel Emulator',
    kind: 'emulator',
    booted: true,
  });

  const error = await adb(['shell', 'echo', 'hi']).then(
    () => assert.fail('expected the adb call to reject'),
    (err: unknown) => err,
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.adbFailure, 'device_offline');
  assert.equal(error.details?.retriable, true);
});

test('attachAdbFailureHint preserves existing hints and ignores non-adb errors', () => {
  const withHint = new AppError('COMMAND_FAILED', 'adb exited with code 1', {
    stderr: 'adb: device offline',
    hint: 'site-specific hint',
  });
  attachAdbFailureHint(withHint);
  assert.equal(withHint.details?.hint, 'site-specific hint');
  assert.equal(withHint.details?.adbFailure, 'device_offline');

  const otherCode = new AppError('TOOL_MISSING', 'adb not found in PATH', {
    stderr: 'adb: device offline',
  });
  attachAdbFailureHint(otherCode);
  assert.equal(Object.hasOwn(otherCode.details ?? {}, 'hint'), false);

  const plain = new Error('boom');
  assert.equal(attachAdbFailureHint(plain), plain);
});

test('port reverse removal failures surface as classified AppErrors, not bare Errors', async () => {
  const provider = createAndroidPortReverseManager(async (args) => {
    if (args[0] === 'reverse' && args[1] === '--remove') {
      return { stdout: '', stderr: 'error: device offline', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const error = await provider.remove('tcp:8081').then(
    () => assert.fail('expected the removal to reject'),
    (err: unknown) => err,
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.adbFailure, 'device_offline');
  assert.equal(error.details?.retriable, true);
  assert.match(String(error.details?.hint), /reconnect/i);
});

test('androidAdbResultError classifies tolerated nonzero results like thrown executor failures', () => {
  const error = androidAdbResultError(
    'adb uninstall failed for com.example.app',
    { exitCode: 1, stdout: '', stderr: 'error: device offline' },
    { package: 'com.example.app' },
  );

  assert.equal(error.code, 'COMMAND_FAILED');
  assert.equal(error.details?.stderr, 'error: device offline');
  assert.equal(error.details?.exitCode, 1);
  assert.equal(error.details?.package, 'com.example.app');
  assert.equal(error.details?.adbFailure, 'device_offline');
  assert.equal(error.details?.retriable, true);
  assert.match(String(error.details?.hint), /adb reconnect/i);
});

test('androidAdbResultError composes the classified hint with the stderr excerpt enrichment', () => {
  const error = androidAdbResultError('adb uninstall failed for com.example.app', {
    exitCode: 1,
    stdout: '',
    stderr: 'error: device offline',
  });

  // execFailureDetails flags processExitError, so normalizeError suffixes the
  // curated message with the stderr excerpt (severity prefix stripped) while
  // the classified hint rides along.
  assert.equal(error.details?.processExitError, true);
  const normalized = normalizeError(error);
  assert.equal(normalized.message, 'adb uninstall failed for com.example.app: device offline');
  assert.match(String(normalized.hint), /adb reconnect/i);
  assert.equal(normalized.retriable, true);
});

test('androidAdbResultError leaves semantic exit-0 failures without excerpt enrichment', () => {
  const error = androidAdbResultError('Failed to launch com.example.app', {
    exitCode: 0,
    stdout: 'Error: Activity not started',
    stderr: 'Warning: unrelated deprecation notice',
  });

  assert.equal(Object.hasOwn(error.details ?? {}, 'processExitError'), false);
  assert.equal(normalizeError(error).message, 'Failed to launch com.example.app');
});

test('androidAdbResultError keeps a site hint over the classified one', () => {
  const error = androidAdbResultError(
    'Failed to pull Android heap dump',
    { exitCode: 1, stdout: '', stderr: 'error: device offline' },
    { hint: 'site-specific hint' },
  );

  assert.equal(error.details?.hint, 'site-specific hint');
  assert.equal(error.details?.adbFailure, 'device_offline');
});

test('semantic provider install failures carry classified hints', async () => {
  const error = await withAndroidAdbProvider(
    {
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      install: async () => {
        throw new AppError('COMMAND_FAILED', 'remote install failed', {
          exitCode: 1,
          stdout: 'Failure [INSTALL_FAILED_UPDATE_INCOMPATIBLE: signatures do not match]',
          stderr: '',
        });
      },
    },
    { serial: 'emulator-5554' },
    async () =>
      await installAndroidAdbPackage('/app.apk', { replace: true }).then(
        () => assert.fail('expected the provider install to reject'),
        (err: unknown) => err,
      ),
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.adbFailure, 'install_update_incompatible');
  assert.match(String(error.details?.hint), /incompatible signature/i);
});

test('explicitly passed provider pull failures carry classified hints', async () => {
  const error = await pullAndroidAdbFile('/remote.mp4', '/local.mp4', {
    provider: {
      exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
      pull: async () => {
        throw new AppError('COMMAND_FAILED', 'remote pull failed', {
          exitCode: 1,
          stdout: '',
          stderr: 'error: device offline',
        });
      },
    },
  }).then(
    () => assert.fail('expected the provider pull to reject'),
    (err: unknown) => err,
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.adbFailure, 'device_offline');
  assert.equal(error.details?.retriable, true);
  assert.match(String(error.details?.hint), /adb reconnect/i);
});

test('provider-scoped adb failures get the same classified hints as local execution', async () => {
  const device = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel Emulator',
    kind: 'emulator',
    booted: true,
  } as const;

  const error = await withAndroidAdbProvider(
    async () => {
      throw new AppError('COMMAND_FAILED', 'remote adb exited with code 1', {
        exitCode: 1,
        stdout: '',
        stderr: 'adb: more than one device/emulator',
      });
    },
    { serial: 'emulator-5554' },
    async () =>
      await resolveAndroidAdbExecutor(device)(['shell', 'echo', 'hi']).then(
        () => assert.fail('expected the provider-scoped call to reject'),
        (err: unknown) => err,
      ),
  );

  assert.ok(error instanceof AppError);
  assert.equal(error.details?.adbFailure, 'multiple_devices');
  assert.match(String(error.details?.hint), /--serial/);
});
