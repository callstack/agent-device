import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseArgs, usage, usageForCommand } from '../args.ts';
import { AppError } from '../errors.ts';
import { listCapabilityCommands } from '../../core/capabilities.ts';
import { listCapabilityCheckedCommandNames, listCliCommandNames } from '../../command-catalog.ts';
import { getCliCommandSchema } from '../command-schema.ts';

test('parseArgs recognizes command-specific flag combinations', async () => {
  const scenarios: Array<{
    label: string;
    argv: string[];
    strictFlags?: boolean;
    assertParsed: (parsed: ReturnType<typeof parseArgs>) => void;
  }> = [
    {
      label: 'open --relaunch',
      argv: ['open', 'settings', '--relaunch'],
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'open');
        assert.deepEqual(parsed.positionals, ['settings']);
        assert.equal(parsed.flags.relaunch, true);
      },
    },
    {
      label: 'open --platform ios --target tv',
      argv: ['open', 'Settings', '--platform', 'ios', '--target', 'tv'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'open');
        assert.equal(parsed.flags.platform, 'ios');
        assert.equal(parsed.flags.target, 'tv');
      },
    },
    {
      label: 'boot --headless on android',
      argv: ['boot', '--platform', 'android', '--device', 'Pixel_9_Pro_XL', '--headless'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'boot');
        assert.equal(parsed.flags.platform, 'android');
        assert.equal(parsed.flags.device, 'Pixel_9_Pro_XL');
        assert.equal(parsed.flags.headless, true);
      },
    },
    {
      label: 'shutdown android emulator',
      argv: ['shutdown', '--platform', 'android', '--device', 'Pixel_9_Pro_XL'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'shutdown');
        assert.equal(parsed.flags.platform, 'android');
        assert.equal(parsed.flags.device, 'Pixel_9_Pro_XL');
      },
    },
    {
      label: 'prepare ios-runner',
      argv: ['prepare', 'ios-runner', '--platform', 'ios', '--timeout', '240000'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'prepare');
        assert.deepEqual(parsed.positionals, ['ios-runner']);
        assert.equal(parsed.flags.platform, 'ios');
        assert.equal(parsed.flags.timeoutMs, 240000);
      },
    },
    {
      label: 'back --in-app',
      argv: ['back', '--in-app'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'back');
        assert.equal(parsed.flags.backMode, 'in-app');
      },
    },
    {
      label: 'back --system',
      argv: ['back', '--system'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'back');
        assert.equal(parsed.flags.backMode, 'system');
      },
    },
    {
      label: 'react-native dismiss-overlay',
      argv: ['react-native', 'dismiss-overlay', '--platform', 'ios'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'react-native');
        assert.deepEqual(parsed.positionals, ['dismiss-overlay']);
        assert.equal(parsed.flags.platform, 'ios');
      },
    },
    {
      label: 'open --platform apple alias',
      argv: ['open', 'Settings', '--platform', 'apple', '--target', 'tv'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'open');
        assert.equal(parsed.flags.platform, 'apple');
        assert.equal(parsed.flags.target, 'tv');
      },
    },
    {
      label: 'open --platform web',
      argv: ['open', 'https://example.com', '--platform', 'web', '--target', 'desktop'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'open');
        assert.equal(parsed.flags.platform, 'web');
        assert.equal(parsed.flags.target, 'desktop');
      },
    },
    {
      label: 'web setup',
      argv: ['web', 'setup', '--state-dir', './tmp/ad-state'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'web');
        assert.deepEqual(parsed.positionals, ['setup']);
        assert.equal(parsed.flags.stateDir, './tmp/ad-state');
      },
    },
    {
      label: 'open --surface frontmost-app',
      argv: ['open', '--platform', 'macos', '--surface', 'frontmost-app'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'open');
        assert.equal(parsed.flags.platform, 'macos');
        assert.equal(parsed.flags.surface, 'frontmost-app');
      },
    },
    {
      label: 'test suite with retries, timeout, artifacts, fail-fast, and replay update',
      argv: [
        'test',
        './suite',
        '--platform',
        'android',
        '--fail-fast',
        '--update',
        '--timeout',
        '60000',
        '--retries',
        '2',
        '--artifacts-dir',
        '.agent-device/test-artifacts',
      ],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'test');
        assert.deepEqual(parsed.positionals, ['./suite']);
        assert.equal(parsed.flags.platform, 'android');
        assert.equal(parsed.flags.failFast, true);
        assert.equal(parsed.flags.replayUpdate, true);
        assert.equal(parsed.flags.timeoutMs, 60000);
        assert.equal(parsed.flags.retries, 2);
        assert.equal(parsed.flags.artifactsDir, '.agent-device/test-artifacts');
      },
    },
    {
      label: 'replay maestro flow',
      argv: ['replay', './flow.yaml', '--maestro', '--env', 'USER=Ada', '--timeout', '240000'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'replay');
        assert.deepEqual(parsed.positionals, ['./flow.yaml']);
        assert.equal(parsed.flags.replayMaestro, true);
        assert.deepEqual(parsed.flags.replayEnv, ['USER=Ada']);
        assert.equal(parsed.flags.timeoutMs, 240000);
      },
    },
    {
      label: 'export replay to maestro yaml',
      argv: ['replay', 'export', './flow.ad', '--format', 'maestro', '--out', './flow.yaml'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'replay');
        assert.deepEqual(parsed.positionals, ['export', './flow.ad']);
        assert.equal(parsed.flags.replayExportFormat, 'maestro');
        assert.equal(parsed.flags.out, './flow.yaml');
      },
    },
    {
      label: 'test maestro suite',
      argv: [
        'test',
        './e2e/maestro',
        '--maestro',
        '--env',
        'APP_ID=com.example',
        '--platform',
        'android',
      ],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'test');
        assert.deepEqual(parsed.positionals, ['./e2e/maestro']);
        assert.equal(parsed.flags.replayMaestro, true);
        assert.deepEqual(parsed.flags.replayEnv, ['APP_ID=com.example']);
        assert.equal(parsed.flags.platform, 'android');
      },
    },
  ];

  for (const scenario of scenarios) {
    scenario.assertParsed(parseArgs(scenario.argv, { strictFlags: scenario.strictFlags }));
  }
});

test('parseArgs recognizes device isolation flags', () => {
  const parsed = parseArgs(
    [
      'devices',
      '--platform',
      'ios',
      '--ios-simulator-device-set',
      '/tmp/tenant-a/simulators',
      '--android-device-allowlist',
      'emulator-5554,device-1234',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'devices');
  assert.equal(parsed.flags.platform, 'ios');
  assert.equal(parsed.flags.iosSimulatorDeviceSet, '/tmp/tenant-a/simulators');
  assert.equal(parsed.flags.androidDeviceAllowlist, 'emulator-5554,device-1234');
});

test('parseArgs rejects test retries above the supported ceiling', () => {
  assert.throws(
    () => parseArgs(['test', './suite', '--retries', '4'], { strictFlags: true }),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      /Invalid retries: 4/.test(error.message),
  );
});

test('parseArgs recognizes logs clear --restart', () => {
  const parsed = parseArgs(['logs', 'clear', '--restart'], { strictFlags: true });
  assert.equal(parsed.command, 'logs');
  assert.deepEqual(parsed.positionals, ['clear']);
  assert.equal(parsed.flags.restart, true);
});

test('parseArgs recognizes network dump arguments', () => {
  const parsed = parseArgs(['network', 'dump', '20', 'headers'], { strictFlags: true });
  assert.equal(parsed.command, 'network');
  assert.deepEqual(parsed.positionals, ['dump', '20', 'headers']);
});

test('parseArgs recognizes network include flag', () => {
  const parsed = parseArgs(['network', 'dump', '20', '--include', 'headers'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'network');
  assert.deepEqual(parsed.positionals, ['dump', '20']);
  assert.equal(parsed.flags.networkInclude, 'headers');
});

test('parseArgs preserves react-devtools arguments as passthrough positionals', () => {
  const parsed = parseArgs(
    [
      'react-devtools',
      'profile',
      'diff',
      '--threshold',
      '10',
      '--limit=5',
      '--json',
      '--session',
      'rn',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'react-devtools');
  assert.equal(parsed.flags.json, true);
  assert.equal(parsed.flags.session, 'rn');
  assert.deepEqual(parsed.positionals, ['profile', 'diff', '--threshold', '10', '--limit=5']);
});

test('parseArgs supports explicit passthrough boundary for react-devtools global flag names', () => {
  const parsed = parseArgs(['react-devtools', '--', 'status', '--json'], { strictFlags: true });
  assert.equal(parsed.command, 'react-devtools');
  assert.equal(parsed.flags.json, false);
  assert.deepEqual(parsed.positionals, ['status', '--json']);
});

test('parseArgs preserves cdp arguments as passthrough positionals', () => {
  const parsed = parseArgs(
    [
      'cdp',
      'memory',
      'snapshot',
      'diff',
      '--base',
      'ms_1',
      '--compare',
      'ms_2',
      '--limit=10',
      '--json',
      '--session',
      'rn',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'cdp');
  assert.equal(parsed.flags.json, false);
  assert.equal(parsed.flags.session, undefined);
  assert.deepEqual(parsed.positionals, [
    'memory',
    'snapshot',
    'diff',
    '--base',
    'ms_1',
    '--compare',
    'ms_2',
    '--limit=10',
    '--json',
    '--session',
    'rn',
  ]);
});

test('parseArgs preserves cdp help as a downstream flag', () => {
  const parsed = parseArgs(['cdp', '--help'], { strictFlags: true });
  assert.equal(parsed.command, 'cdp');
  assert.equal(parsed.flags.help, false);
  assert.deepEqual(parsed.positionals, ['--help']);
});

test('parseArgs accepts agent-device globals before cdp passthrough args', () => {
  const parsed = parseArgs(
    [
      '--session',
      'outer-session',
      'cdp',
      'target',
      'list',
      '--target',
      'Hermes',
      '--device',
      'rn-app',
      '--json',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'cdp');
  assert.equal(parsed.flags.session, 'outer-session');
  assert.equal(parsed.flags.json, false);
  assert.deepEqual(parsed.positionals, [
    'target',
    'list',
    '--target',
    'Hermes',
    '--device',
    'rn-app',
    '--json',
  ]);
});

test('parseArgs supports explicit passthrough boundary for cdp global flag names', () => {
  const parsed = parseArgs(['cdp', '--', 'target', 'list', '--url', 'http://127.0.0.1:8081'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'cdp');
  assert.deepEqual(parsed.positionals, ['target', 'list', '--url', 'http://127.0.0.1:8081']);
});

test('parseArgs accepts push with payload file', () => {
  const parsed = parseArgs(['push', 'com.example.app', './payload.json'], { strictFlags: true });
  assert.equal(parsed.command, 'push');
  assert.deepEqual(parsed.positionals, ['com.example.app', './payload.json']);
});

test('parseArgs accepts install command args', () => {
  const parsed = parseArgs(['install', 'com.example.app', './build/app.apk'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'install');
  assert.deepEqual(parsed.positionals, ['com.example.app', './build/app.apk']);
});

test('parseArgs accepts install with artifact path only', () => {
  const parsed = parseArgs(['install', './build/app.apk'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'install');
  assert.deepEqual(parsed.positionals, ['./build/app.apk']);
});

test('parseArgs accepts install-from-source url and repeated headers', () => {
  const parsed = parseArgs(
    [
      'install-from-source',
      'https://example.com/builds/app.apk',
      '--header',
      'authorization: Bearer token',
      '--header',
      'x-build-id: 42',
      '--retain-paths',
      '--retention-ms',
      '60000',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'install-from-source');
  assert.deepEqual(parsed.positionals, ['https://example.com/builds/app.apk']);
  assert.deepEqual(parsed.flags.header, ['authorization: Bearer token', 'x-build-id: 42']);
  assert.equal(parsed.flags.retainPaths, true);
  assert.equal(parsed.flags.retentionMs, 60000);
});

test('parseArgs accepts open --launch-args with plain values', () => {
  const parsed = parseArgs(
    ['open', 'com.example.app', '--launch-args', 'fixtureMode', '--launch-args', 'verbose'],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'open');
  assert.deepEqual(parsed.positionals, ['com.example.app']);
  assert.deepEqual(parsed.flags.launchArgs, ['fixtureMode', 'verbose']);
});

test('parseArgs accepts open --launch-args with dash-prefixed values', () => {
  const parsed = parseArgs(
    [
      'open',
      'com.example.app',
      '--platform',
      'ios',
      '--launch-args',
      '-FeatureFlag',
      '--launch-args',
      'YES',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'open');
  assert.deepEqual(parsed.flags.launchArgs, ['-FeatureFlag', 'YES']);
});

test('parseArgs accepts open --launch-args with double-dash-prefixed values', () => {
  const parsed = parseArgs(
    [
      'open',
      'com.example.app',
      '--launch-args',
      '--es',
      '--launch-args',
      'EXTRA_CONFIG',
      '--launch-args',
      '{"mode":"debug"}',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'open');
  assert.deepEqual(parsed.flags.launchArgs, ['--es', 'EXTRA_CONFIG', '{"mode":"debug"}']);
});

test('parseArgs rejects --launch-args on commands that do not allow it', () => {
  assert.throws(
    () => parseArgs(['tap', '100', '200', '--launch-args', 'foo'], { strictFlags: true }),
    (error) => error instanceof AppError && error.code === 'INVALID_ARGS',
  );
});

test('usageForCommand documents open --launch-args', () => {
  const help = usageForCommand('open');
  if (help === null) throw new Error('Expected open help text');
  assert.match(help, /--launch-args <arg>/);
  assert.match(help, /forwarded verbatim/);
  assert.match(help, /Linux and macOS reject the flag/);
  assert.match(help, /--launch-console artifacts\/launch-console\.log/);
});

test('parseArgs accepts install-from-source GitHub Actions artifact flag', () => {
  const parsed = parseArgs(
    [
      'install-from-source',
      '--github-actions-artifact',
      'thymikee/RNCLI83:6635342232',
      '--platform',
      'android',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'install-from-source');
  assert.deepEqual(parsed.positionals, []);
  assert.equal(parsed.flags.githubActionsArtifact, 'thymikee/RNCLI83:6635342232');
  assert.equal(parsed.flags.platform, 'android');
});

test('parseArgs accepts metro prepare arguments', () => {
  const parsed = parseArgs(
    [
      'metro',
      'prepare',
      '--project-root',
      './apps/demo',
      '--public-base-url',
      'https://sandbox.example.test',
      '--proxy-base-url',
      'https://proxy.example.test',
      '--bearer-token',
      'secret',
      '--port',
      '9090',
      '--kind',
      'expo',
      '--runtime-file',
      './.agent-device/metro-runtime.json',
      '--no-reuse-existing',
      '--no-install-deps',
    ],
    { strictFlags: true },
  );

  assert.equal(parsed.command, 'metro');
  assert.deepEqual(parsed.positionals, ['prepare']);
  assert.equal(parsed.flags.metroProjectRoot, './apps/demo');
  assert.equal(parsed.flags.metroPublicBaseUrl, 'https://sandbox.example.test');
  assert.equal(parsed.flags.metroProxyBaseUrl, 'https://proxy.example.test');
  assert.equal(parsed.flags.metroBearerToken, 'secret');
  assert.equal(parsed.flags.metroPreparePort, 9090);
  assert.equal(parsed.flags.kind, 'expo');
  assert.equal(parsed.flags.metroRuntimeFile, './.agent-device/metro-runtime.json');
  assert.equal(parsed.flags.metroNoReuseExisting, true);
  assert.equal(parsed.flags.metroNoInstallDeps, true);
});

test('parseArgs accepts metro reload arguments', () => {
  const parsed = parseArgs(
    [
      'metro',
      'reload',
      '--metro-host',
      '127.0.0.1',
      '--metro-port',
      '9090',
      '--bundle-url',
      'http://127.0.0.1:9090/index.bundle?platform=ios',
      '--probe-timeout-ms',
      '1500',
    ],
    { strictFlags: true },
  );

  assert.equal(parsed.command, 'metro');
  assert.deepEqual(parsed.positionals, ['reload']);
  assert.equal(parsed.flags.metroHost, '127.0.0.1');
  assert.equal(parsed.flags.metroPort, 9090);
  assert.equal(parsed.flags.bundleUrl, 'http://127.0.0.1:9090/index.bundle?platform=ios');
  assert.equal(parsed.flags.metroProbeTimeoutMs, 1500);
});

test('parseArgs accepts remote workflow profile flag', () => {
  const parsed = parseArgs(
    [
      'connect',
      '--remote-config',
      './agent-device.remote.json',
      '--tenant',
      'acme',
      '--run-id',
      'run-1',
    ],
    {
      strictFlags: true,
    },
  );
  assert.equal(parsed.command, 'connect');
  assert.deepEqual(parsed.positionals, []);
  assert.equal(parsed.flags.remoteConfig, './agent-device.remote.json');
});

test('parseArgs accepts clipboard subcommands', () => {
  const read = parseArgs(['clipboard', 'read'], { strictFlags: true });
  assert.equal(read.command, 'clipboard');
  assert.deepEqual(read.positionals, ['read']);

  const write = parseArgs(['clipboard', 'write', 'otp', '123456'], { strictFlags: true });
  assert.equal(write.command, 'clipboard');
  assert.deepEqual(write.positionals, ['write', 'otp', '123456']);
});

test('parseArgs accepts keyboard subcommands', () => {
  const status = parseArgs(['keyboard', 'status'], { strictFlags: true });
  assert.equal(status.command, 'keyboard');
  assert.deepEqual(status.positionals, ['status']);

  const dismiss = parseArgs(['keyboard', 'dismiss'], { strictFlags: true });
  assert.equal(dismiss.command, 'keyboard');
  assert.deepEqual(dismiss.positionals, ['dismiss']);

  const enter = parseArgs(['keyboard', 'enter'], { strictFlags: true });
  assert.equal(enter.command, 'keyboard');
  assert.deepEqual(enter.positionals, ['enter']);
});

test('parseArgs accepts scroll pixel distance and duration flags', () => {
  const parsed = parseArgs(['scroll', 'down', '--pixels', '240', '--duration-ms', '50'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'scroll');
  assert.deepEqual(parsed.positionals, ['down']);
  assert.equal(parsed.flags.pixels, 240);
  assert.equal(parsed.flags.durationMs, 50);
});

test('parseArgs recognizes --debug alias for verbose mode', () => {
  const parsed = parseArgs(['open', 'settings', '--debug']);
  assert.equal(parsed.command, 'open');
  assert.deepEqual(parsed.positionals, ['settings']);
  assert.equal(parsed.flags.verbose, true);
});

test('parseArgs recognizes daemon transport/state/tenant isolation flags', () => {
  const parsed = parseArgs(
    [
      'open',
      'settings',
      '--state-dir',
      './tmp/ad-state',
      '--daemon-base-url',
      'https://remote-mac.example.test:7777/agent-device',
      '--daemon-auth-token',
      'remote-secret',
      '--daemon-transport',
      'http',
      '--daemon-server-mode',
      'dual',
      '--tenant',
      'team_alpha',
      '--session-isolation',
      'tenant',
      '--run-id',
      'run_42',
      '--lease-id',
      'abcd1234ef567890',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.flags.stateDir, './tmp/ad-state');
  assert.equal(parsed.flags.daemonBaseUrl, 'https://remote-mac.example.test:7777/agent-device');
  assert.equal(parsed.flags.daemonAuthToken, 'remote-secret');
  assert.equal(parsed.flags.daemonTransport, 'http');
  assert.equal(parsed.flags.daemonServerMode, 'dual');
  assert.equal(parsed.flags.tenant, 'team_alpha');
  assert.equal(parsed.flags.sessionIsolation, 'tenant');
  assert.equal(parsed.flags.runId, 'run_42');
  assert.equal(parsed.flags.leaseId, 'abcd1234ef567890');
});

test('parseArgs scopes daemon and device flags to supported commands', () => {
  const open = parseArgs(['open', 'settings', '--ios-xctestrun-file', './runner.xctestrun'], {
    strictFlags: true,
  });
  assert.equal(open.flags.iosXctestrunFile, './runner.xctestrun');

  assert.throws(
    () =>
      parseArgs(['auth', 'status', '--ios-xctestrun-file', './runner.xctestrun'], {
        strictFlags: true,
      }),
    /not supported for command auth/,
  );

  assert.throws(
    () => parseArgs(['auth', 'status', '--platform', 'ios'], { strictFlags: true }),
    /not supported for command auth/,
  );
});

test('parseArgs keeps no-record accepted on recordable commands', () => {
  const press = parseArgs(['press', '10', '10', '--no-record'], { strictFlags: true });
  assert.equal(press.flags.noRecord, true);

  const swipe = parseArgs(['swipe', '0', '0', '10', '10', '--no-record'], {
    strictFlags: true,
  });
  assert.equal(swipe.flags.noRecord, true);
});

test('parseArgs recognizes connect lease backend force and no-login flags', () => {
  const parsed = parseArgs(
    [
      'connect',
      '--remote-config',
      './remote.json',
      '--tenant',
      'acme',
      '--run-id',
      'run-123',
      '--lease-backend',
      'android-instance',
      '--force',
      '--no-login',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'connect');
  assert.equal(parsed.flags.remoteConfig, './remote.json');
  assert.equal(parsed.flags.leaseBackend, 'android-instance');
  assert.equal(parsed.flags.force, true);
  assert.equal(parsed.flags.noLogin, true);
});

test('parseArgs preserves connect proxy provider positional', () => {
  const parsed = parseArgs(
    ['connect', 'proxy', '--daemon-base-url', 'http://host:4310/agent-device'],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'connect');
  assert.deepEqual(parsed.positionals, ['proxy']);
  assert.equal(parsed.flags.daemonBaseUrl, 'http://host:4310/agent-device');
});

test('parseArgs accepts auth management subcommands', () => {
  const status = parseArgs(['auth', 'status'], { strictFlags: true });
  assert.equal(status.command, 'auth');
  assert.deepEqual(status.positionals, ['status']);

  const login = parseArgs(['auth', 'login', '--remote-config', './remote.json'], {
    strictFlags: true,
  });
  assert.equal(login.command, 'auth');
  assert.deepEqual(login.positionals, ['login']);
  assert.equal(login.flags.remoteConfig, './remote.json');
});

test('parseArgs accepts proxy command flags', () => {
  const parsed = parseArgs(
    [
      'proxy',
      '--state-dir',
      './tmp/ad-state',
      '--host',
      '0.0.0.0',
      '--port',
      '4310',
      '--daemon-auth-token',
      'proxy-secret',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'proxy');
  assert.equal(parsed.flags.stateDir, './tmp/ad-state');
  assert.equal(parsed.flags.proxyHost, '0.0.0.0');
  assert.equal(parsed.flags.proxyPort, 4310);
  assert.equal(parsed.flags.daemonAuthToken, 'proxy-secret');
});

test('parseArgs recognizes explicit config file flag', () => {
  const parsed = parseArgs(['open', 'settings', '--config', './agent-device.json'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'open');
  assert.equal(parsed.flags.config, './agent-device.json');
});

test('parseArgs recognizes open Device Hub opt-in flag', () => {
  const parsed = parseArgs(['open', 'settings', '--platform', 'ios', '--device-hub'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'open');
  assert.equal(parsed.flags.platform, 'ios');
  assert.equal(parsed.flags.deviceHub, true);
});

test('parseArgs recognizes session lock policy flag', () => {
  const parsed = parseArgs(['snapshot', '--session-lock', 'strip'], { strictFlags: true });
  assert.equal(parsed.command, 'snapshot');
  assert.equal(parsed.flags.sessionLock, 'strip');
});

test('parseArgs keeps deprecated session lock aliases for compatibility', () => {
  const parsed = parseArgs(['snapshot', '--session-locked', '--session-lock-conflicts', 'strip'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'snapshot');
  assert.equal(parsed.flags.sessionLocked, true);
  assert.equal(parsed.flags.sessionLockConflicts, 'strip');
});

test('batch requires exactly one step source', () => {
  assert.throws(
    () => parseArgs(['batch'], { strictFlags: true }),
    /requires exactly one step source/,
  );
  assert.throws(
    () =>
      parseArgs(['batch', '--steps', '[]', '--steps-file', './steps.json'], { strictFlags: true }),
    /requires exactly one step source/,
  );
  const inline = parseArgs(['batch', '--steps', '[]'], { strictFlags: true });
  assert.equal(inline.command, 'batch');
  assert.equal(inline.flags.steps, '[]');
  assert.throws(
    () => parseArgs(['batch', '--steps', '[]', '--on-error', 'continue'], { strictFlags: true }),
    /Invalid on-error: continue/,
  );
});

test('parseArgs accepts --save-script with optional path value', () => {
  const withoutPath = parseArgs(['open', 'settings', '--save-script']);
  assert.equal(withoutPath.command, 'open');
  assert.deepEqual(withoutPath.positionals, ['settings']);
  assert.equal(withoutPath.flags.saveScript, true);

  const withPath = parseArgs(['open', 'settings', '--save-script', './workflows/my-flow.ad']);
  assert.equal(withPath.command, 'open');
  assert.deepEqual(withPath.positionals, ['settings']);
  assert.equal(withPath.flags.saveScript, './workflows/my-flow.ad');

  const nonPathPositional = parseArgs(['open', '--save-script', 'settings']);
  assert.equal(nonPathPositional.command, 'open');
  assert.deepEqual(nonPathPositional.positionals, ['settings']);
  assert.equal(nonPathPositional.flags.saveScript, true);

  const inlineValue = parseArgs(['open', 'settings', '--save-script=my-flow.ad']);
  assert.equal(inlineValue.command, 'open');
  assert.deepEqual(inlineValue.positionals, ['settings']);
  assert.equal(inlineValue.flags.saveScript, 'my-flow.ad');

  const ambiguousBareValue = parseArgs(['open', '--save-script', 'my-flow.ad']);
  assert.equal(ambiguousBareValue.command, 'open');
  assert.deepEqual(ambiguousBareValue.positionals, ['my-flow.ad']);
  assert.equal(ambiguousBareValue.flags.saveScript, true);
});

test('parseArgs recognizes press series flags', () => {
  const parsed = parseArgs([
    'press',
    '300',
    '500',
    '--count',
    '12',
    '--interval-ms=45',
    '--hold-ms',
    '120',
    '--jitter-px',
    '3',
  ]);
  assert.equal(parsed.command, 'press');
  assert.deepEqual(parsed.positionals, ['300', '500']);
  assert.equal(parsed.flags.count, 12);
  assert.equal(parsed.flags.intervalMs, 45);
  assert.equal(parsed.flags.holdMs, 120);
  assert.equal(parsed.flags.jitterPx, 3);
});

test('parseArgs recognizes press selector + snapshot flags', () => {
  const parsed = parseArgs(['press', '@e2', '--depth', '3', '--scope', 'Sign In', '--raw'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'press');
  assert.deepEqual(parsed.positionals, ['@e2']);
  assert.equal(parsed.flags.snapshotDepth, 3);
  assert.equal(parsed.flags.snapshotScope, 'Sign In');
  assert.equal(parsed.flags.snapshotRaw, true);
});

test('parseArgs recognizes click series flags', () => {
  const parsed = parseArgs(['click', '@e5', '--count', '4', '--interval-ms', '10'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'click');
  assert.deepEqual(parsed.positionals, ['@e5']);
  assert.equal(parsed.flags.count, 4);
  assert.equal(parsed.flags.intervalMs, 10);
});

test('parseArgs recognizes click button flag', () => {
  const parsed = parseArgs(['click', '@e5', '--button', 'secondary'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'click');
  assert.deepEqual(parsed.positionals, ['@e5']);
  assert.equal(parsed.flags.clickButton, 'secondary');
});

test('parseArgs recognizes double-tap flag for repeated press', () => {
  const parsed = parseArgs(['press', '201', '545', '--count', '5', '--double-tap'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'press');
  assert.deepEqual(parsed.positionals, ['201', '545']);
  assert.equal(parsed.flags.count, 5);
  assert.equal(parsed.flags.doubleTap, true);
});

test('parseArgs recognizes swipe positional + pattern flags', () => {
  const parsed = parseArgs([
    'swipe',
    '540',
    '1500',
    '540',
    '500',
    '120',
    '--count',
    '8',
    '--pause-ms',
    '30',
    '--pattern',
    'ping-pong',
  ]);
  assert.equal(parsed.command, 'swipe');
  assert.deepEqual(parsed.positionals, ['540', '1500', '540', '500', '120']);
  assert.equal(parsed.flags.count, 8);
  assert.equal(parsed.flags.pauseMs, 30);
  assert.equal(parsed.flags.pattern, 'ping-pong');
});

test('parseArgs recognizes gesture subcommand positionals', () => {
  const pan = parseArgs(['gesture', 'pan', '200', '420', '0', '-80', '500'], {
    strictFlags: true,
  });
  assert.equal(pan.command, 'gesture');
  assert.deepEqual(pan.positionals, ['pan', '200', '420', '0', '-80', '500']);

  const fling = parseArgs(['gesture', 'fling', 'right', '200', '420', '180'], {
    strictFlags: true,
  });
  assert.equal(fling.command, 'gesture');
  assert.deepEqual(fling.positionals, ['fling', 'right', '200', '420', '180']);

  const rotate = parseArgs(['gesture', 'rotate', '35', '200', '420'], {
    strictFlags: true,
  });
  assert.equal(rotate.command, 'gesture');
  assert.deepEqual(rotate.positionals, ['rotate', '35', '200', '420']);

  const transform = parseArgs(['gesture', 'transform', '200', '420', '80', '-40', '2', '35'], {
    strictFlags: true,
  });
  assert.equal(transform.command, 'gesture');
  assert.deepEqual(transform.positionals, ['transform', '200', '420', '80', '-40', '2', '35']);
});

test('parseArgs recognizes type and fill delay flags', () => {
  const typeParsed = parseArgs(['type', 'hello', '--delay-ms', '75'], {
    strictFlags: true,
  });
  assert.equal(typeParsed.command, 'type');
  assert.deepEqual(typeParsed.positionals, ['hello']);
  assert.equal(typeParsed.flags.delayMs, 75);

  const fillParsed = parseArgs(['fill', '@e5', 'search', '--delay-ms', '40'], {
    strictFlags: true,
  });
  assert.equal(fillParsed.command, 'fill');
  assert.deepEqual(fillParsed.positionals, ['@e5', 'search']);
  assert.equal(fillParsed.flags.delayMs, 40);
});

test('parseArgs recognizes record --fps flag', () => {
  const parsed = parseArgs(['record', 'start', './capture.mp4', '--fps', '30'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'record');
  assert.deepEqual(parsed.positionals, ['start', './capture.mp4']);
  assert.equal(parsed.flags.fps, 30);
});

test('parseArgs recognizes record --quality flag', () => {
  const parsed = parseArgs(['record', 'start', './capture.mp4', '--quality', 'high'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'record');
  assert.deepEqual(parsed.positionals, ['start', './capture.mp4']);
  assert.equal(parsed.flags.quality, 'high');
});

test('parseArgs recognizes record --max-size flag', () => {
  const parsed = parseArgs(['record', 'start', './capture.mp4', '--max-size', '1024'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'record');
  assert.deepEqual(parsed.positionals, ['start', './capture.mp4']);
  assert.equal(parsed.flags.screenshotMaxSize, 1024);
});

test('parseArgs recognizes record --hide-touches flag', () => {
  const parsed = parseArgs(['record', 'start', './capture.mp4', '--hide-touches'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'record');
  assert.deepEqual(parsed.positionals, ['start', './capture.mp4']);
  assert.equal(parsed.flags.hideTouches, true);
});

test('parseArgs recognizes screenshot flags', () => {
  const parsed = parseArgs(
    [
      'screenshot',
      'page.png',
      '--full',
      '-f',
      '--fullscreen',
      '--max-size',
      '1024',
      '--no-stabilize',
    ],
    {
      strictFlags: true,
    },
  );
  assert.equal(parsed.command, 'screenshot');
  assert.deepEqual(parsed.positionals, ['page.png']);
  assert.equal(parsed.flags.screenshotFullscreen, true);
  assert.equal(parsed.flags.screenshotMaxSize, 1024);
  assert.equal(parsed.flags.screenshotNoStabilize, true);
});

test('usageForCommand documents screenshot web aliases and stabilization flags', () => {
  const help = usageForCommand('screenshot');
  if (help === null) throw new Error('Expected screenshot help text');
  assert.match(help, /--fullscreen, --full, -f/);
  assert.match(help, /entire page/i);
  assert.match(help, /--no-stabilize/);
  assert.match(help, /low-latency Android capture loops/);
});

test('parseArgs recognizes viewport command', () => {
  const parsed = parseArgs(['viewport', '1280', '900', '--platform', 'web'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'viewport');
  assert.deepEqual(parsed.positionals, ['1280', '900']);
  assert.equal(parsed.flags.platform, 'web');
});

test('parseArgs rejects invalid record --fps range', () => {
  assert.throws(
    () => parseArgs(['record', 'start', './capture.mp4', '--fps', '0'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Invalid fps: 0',
  );
});

test('parseArgs recognizes longpress command', () => {
  const parsed = parseArgs(['longpress', '300', '500', '800'], { strictFlags: true });
  assert.equal(parsed.command, 'longpress');
  assert.deepEqual(parsed.positionals, ['300', '500', '800']);
});

test('parseArgs supports legacy long-press alias', () => {
  const parsed = parseArgs(['long-press', '300', '500', '800'], { strictFlags: true });
  assert.equal(parsed.command, 'longpress');
  assert.deepEqual(parsed.positionals, ['300', '500', '800']);
});

test('parseArgs supports metrics alias for perf', () => {
  const parsed = parseArgs(['metrics'], { strictFlags: true });
  assert.equal(parsed.command, 'perf');
  assert.deepEqual(parsed.positionals, []);
});

test('parseArgs supports trigger-app-event payload argument', () => {
  const parsed = parseArgs(['trigger-app-event', 'screenshot_taken', '{"source":"qa"}'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'trigger-app-event');
  assert.deepEqual(parsed.positionals, ['screenshot_taken', '{"source":"qa"}']);
});

test('parseArgs accepts rotate orientation aliases', () => {
  const parsed = parseArgs(['rotate', 'left'], { strictFlags: true });
  assert.equal(parsed.command, 'rotate');
  assert.deepEqual(parsed.positionals, ['left']);
});

test('usageForCommand resolves longpress help', () => {
  const help = usageForCommand('longpress');
  assert.equal(help === null, false);
  assert.match(help ?? '', /agent-device longpress <x y\|@ref\|selector> \[durationMs\]/);
});

test('usageForCommand supports legacy long-press alias', () => {
  const help = usageForCommand('long-press');
  assert.equal(help === null, false);
  assert.match(help ?? '', /agent-device longpress <x y\|@ref\|selector> \[durationMs\]/);
  assert.doesNotMatch(help ?? '', /agent-device long-press/);
});

test('usageForCommand documents keyboard dismissal flow', () => {
  const help = usageForCommand('keyboard');
  assert.equal(help === null, false);
  assert.match(help ?? '', /focus the field by id\/ref first/);
  assert.match(help ?? '', /keyboard dismiss reports unsupported/);
});

test('usageForCommand supports metrics alias', () => {
  const help = usageForCommand('metrics');
  assert.equal(help === null, false);
  assert.match(help ?? '', /agent-device perf/);
  assert.match(help ?? '', /report --kind xctrace --out <report\.json>/);
  assert.match(help ?? '', /profile report --kind simpleperf --out <cpu-report\.json>/);
  assert.match(help ?? '', /report writes a compact \.json summary/);
  assert.match(help ?? '', /Native perf output is agent evidence/);
  assert.match(help ?? '', /raw profiles\/traces stay on disk/);
});

test('parseArgs rejects invalid swipe pattern', () => {
  assert.throws(
    () => parseArgs(['swipe', '0', '0', '10', '10', '--pattern', 'diagonal']),
    /Invalid pattern/,
  );
});

test('parseArgs rejects conflicting back mode flags', () => {
  assert.throws(
    () => parseArgs(['back', '--in-app', '--system'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message ===
        'back accepts only one explicit mode flag: use either --in-app or --system.',
  );
});

test('usage includes concise top-level commands', () => {
  const usageText = usage();
  assert.match(
    usageText,
    /install-from-source\s{2,}Install app builds from URLs, remote source specs, or CI artifacts/,
  );
  assert.match(usageText, /prepare\s{2,}Pre-warm platform helpers/);
  assert.match(
    usageText,
    /metro\s{2,}Prepare Metro reachability for React Native\/Expo apps or trigger app reloads/,
  );
  assert.match(usageText, /batch --steps <json> \| --steps-file <path>/);
  assert.match(usageText, /network\s{2,}Inspect HTTP\(S\) traffic parsed from session app logs/);
  assert.match(usageText, /clipboard read \| clipboard write <text>/);
  assert.match(usageText, /keyboard \[action\]/);
  assert.match(usageText, /trigger-app-event\s{2,}Invoke app-defined automation\/test events/);
  assert.match(usageText, /gesture <pan\|fling\|swipe\|pinch\|rotate\|transform> \.\.\./);
  assert.doesNotMatch(
    usageText,
    /install-from-source <url> \| install-from-source --github-actions-artifact/,
  );
  assert.doesNotMatch(usageText, /prepare ios-runner --platform ios\|macos/);
  assert.doesNotMatch(usageText, /metro prepare --public-base-url <url>/);
  assert.doesNotMatch(usageText, /^  network dump/m);
  assert.doesNotMatch(usageText, /trigger-app-event <event> \[payloadJson\]/);
  assert.doesNotMatch(usageText, /^  pan <x> <y> <dx> <dy> \[durationMs\]/m);
  assert.doesNotMatch(usageText, /^  fling <up\|down\|left\|right>/m);
  assert.doesNotMatch(usageText, /^  pinch <scale> \[x\] \[y\]/m);
  assert.doesNotMatch(usageText, /^  rotate-gesture <degrees>/m);
  assert.match(usageText, /rotate <orientation>/);
  assert.match(usageText, /record start \[path\] \| record stop/);
  assert.match(usageText, /trace start <path> \| trace stop <path>/);
});

test('usage includes only global flags in the top-level global flags section', () => {
  const usageText = usage();
  const flagsSection = usageText.slice(
    usageText.indexOf('Global Flags:'),
    usageText.indexOf('Agent Quickstart:'),
  );
  assert.match(flagsSection, /^Global Flags:/);
  assert.match(flagsSection, /--config <path>/);
  assert.match(flagsSection, /--json/);
  assert.match(flagsSection, /--help, -h/);
  assert.match(flagsSection, /--version, -V/);
  assert.match(flagsSection, /test --verbose prints per-test step timings without debug logs/);
  assert.doesNotMatch(flagsSection, /--target mobile\|tv/);
  assert.doesNotMatch(flagsSection, /--ios-simulator-device-set <path>/);
  assert.doesNotMatch(flagsSection, /--android-device-allowlist <serials>/);
  assert.doesNotMatch(flagsSection, /--state-dir <path>/);
  assert.doesNotMatch(flagsSection, /--daemon-transport auto\|socket\|http/);
  assert.doesNotMatch(flagsSection, /--daemon-server-mode socket\|http\|dual/);
  assert.doesNotMatch(flagsSection, /--tenant <id>/);
  assert.doesNotMatch(flagsSection, /--session-isolation none\|tenant/);
  assert.doesNotMatch(flagsSection, /--run-id <id>/);
  assert.doesNotMatch(flagsSection, /--lease-id <id>/);
  assert.doesNotMatch(
    flagsSection,
    /--lease-backend ios-simulator\|ios-instance\|android-instance/,
  );
  assert.doesNotMatch(flagsSection, /--relaunch/);
  assert.doesNotMatch(flagsSection, /--header <name:value>/);
  assert.doesNotMatch(flagsSection, /--restart/);
  assert.doesNotMatch(flagsSection, /--fps <n>/);
  assert.doesNotMatch(flagsSection, /--quality <medium\|high>/);
  assert.doesNotMatch(flagsSection, /--save-script \[path\]/);
  assert.doesNotMatch(flagsSection, /--metadata/);
});

test('usage includes agent workflows, config, environment, and examples footers', () => {
  const usageText = usage();
  assert.match(
    usageText,
    /CLI to automate supported app, device, desktop, and web targets for AI agents/,
  );
  assert.ok(
    usageText.indexOf('Agent Workflows:') < usageText.indexOf('Commands:'),
    'Agent workflows should appear before the command list for agents that only read the top of help.',
  );
  assert.ok(
    usageText.indexOf('Agent Starting Point:') < usageText.indexOf('Agent Workflows:'),
    'The agent starting point should appear before topic selection.',
  );
  assert.match(usageText, /Agent Starting Point:/);
  assert.match(
    usageText,
    /agent-device is the default automation surface for app\/device workflows across supported targets/,
  );
  assert.match(
    usageText,
    /Default to agent-device for installs, opens, snapshots, interactions, screenshots, logs, network\/perf evidence, and verification/,
  );
  assert.match(
    usageText,
    /Use raw adb, simctl, xcrun, or platform scripts only when this help calls out a tool gap or platform setup step/,
  );
  assert.match(
    usageText,
    /Start with agent-device help workflow to understand the core loop and how to use the tool/,
  );
  assert.match(usageText, /Agent Quickstart:/);
  assert.match(usageText, /Default loop: devices\/apps -> open -> snapshot -i/);
  assert.match(usageText, /Use selectors or refs as positional targets/);
  assert.match(
    usageText,
    /Plain snapshot reads state; snapshot -i refreshes current interactive refs only/,
  );
  assert.match(usageText, /agent-facing, token-efficient view for planning and targeting actions/);
  assert.match(usageText, /Truncated text\/input preview: expand first with snapshot -s @e12/);
  assert.match(usageText, /React Native apps: read help react-native/);
  assert.match(usageText, /localhost URL opens with a port auto-configure host reachability/);
  assert.match(usageText, /Expo Go\/dev clients: use the provided URL when given/);
  assert.match(usageText, /open "Expo Go" <url> --platform ios/);
  assert.match(usageText, /Do not use plain snapshot or snapshot --diff for this recovery check/);
  assert.match(usageText, /Install flows: install\/install-from-source first/);
  assert.match(usageText, /fill 'id="field-email"' "qa@example\.com" replaces/);
  assert.match(usageText, /do not use fill <target> ""/);
  assert.match(usageText, /Android IME capture: if fill says input was captured/);
  assert.match(usageText, /Implicit default sessions are scoped to the current worktree/);
  assert.match(usageText, /if a prompt names a Session, include --session <name>/);
  assert.match(usageText, /Run mutating commands serially within one session/);
  assert.match(usageText, /After mutation: refs are stale/);
  assert.match(usageText, /use its selector directly; otherwise refresh with snapshot -i/);
  assert.match(usageText, /verify the action with diff snapshot -i or snapshot --diff/);
  assert.match(usageText, /Sparse or AX-unavailable snapshot/);
  assert.match(usageText, /macOS context menus use click <ref> --button secondary/);
  assert.match(
    usageText,
    /Remote lifecycle: use connect, then open, commands, close, and disconnect/,
  );
  assert.match(usageText, /connect proxy --daemon-base-url <proxy-agent-device-url>/);
  assert.match(usageText, /Device leases are automatic on open/);
  assert.match(usageText, /expire after five minutes of inactivity/);
  assert.match(usageText, /app-owned back uses back/);
  assert.match(usageText, /Web browser sessions: read help web/);
  assert.match(
    usageText,
    /open <url> --platform web -> snapshot -i -> click\/fill\/get\/is\/find\/wait\/screenshot -> close/,
  );
  assert.match(usageText, /Session state contains request diagnostics and runner\.log/);
  assert.match(usageText, /logs clear --restart\/mark\/path/);
  assert.match(usageText, /network dump --include headers/);
  assert.match(usageText, /Full operating guide: agent-device help workflow/);
  assert.match(usageText, /Exploratory QA: agent-device help dogfood/);
  assert.match(usageText, /Agent Workflows:/);
  assert.match(
    usageText,
    /agent-device help workflow\s+Start here for the core loop, command shape, refs\/selectors, and verification/,
  );
  assert.match(
    usageText,
    /agent-device help debugging\s+Use when logs, network, perf memory, traces, alerts, or diagnostics matter/,
  );
  assert.match(
    usageText,
    /agent-device help react-devtools\s+Use when inspecting components, props\/state\/hooks, renders, or profiles/,
  );
  assert.match(
    usageText,
    /agent-device help physical-device\s+Use when using a connected phone\/tablet or iOS signing setup/,
  );
  assert.match(
    usageText,
    /agent-device help react-native\s+Use when the target app is React Native, Expo, or a dev client/,
  );
  assert.match(
    usageText,
    /agent-device help web\s+Use when automating a browser through agent-device sessions/,
  );
  assert.match(usageText, /Configuration:/);
  assert.match(
    usageText,
    /Default config files: ~\/\.agent-device\/config\.json, \.\/agent-device\.json/,
  );
  assert.match(
    usageText,
    /Use --config <path> or AGENT_DEVICE_CONFIG to load one explicit config file\./,
  );
  assert.match(usageText, /Environment:/);
  assert.match(usageText, /AGENT_DEVICE_SESSION\s+Explicit session name/);
  assert.match(usageText, /AGENT_DEVICE_PLATFORM\s+Default platform binding/);
  assert.match(usageText, /AGENT_DEVICE_SESSION_LOCK\s+Bound-session conflict mode/);
  assert.match(usageText, /AGENT_DEVICE_DAEMON_BASE_URL\s+Connect to remote daemon/);
  assert.match(usageText, /Examples:/);
  assert.match(usageText, /agent-device open Settings --platform ios/);
  assert.match(usageText, /agent-device open https:\/\/example\.com --platform web/);
  assert.match(usageText, /agent-device snapshot -i/);
  assert.match(usageText, /agent-device fill @e3 "test@example\.com"/);
  assert.match(usageText, /agent-device replay \.\/session\.ad/);
  assert.match(usageText, /agent-device test \.\/suite --platform android/);
});

test('usageForCommand includes Maestro replay flag', () => {
  const help = usageForCommand('replay');
  if (help === null) throw new Error('Expected replay help text');
  assert.match(help, /replay <path> \| replay export <file\.ad>/);
  assert.match(help, /--format maestro/);
  assert.match(help, /--out <path>/);
  assert.match(help, /--maestro/);
  assert.match(help, /doubleTapOn/);
  assert.match(help, /pasteText/);
  assert.match(help, /runFlow file\/inline/);
  assert.match(help, /ordered trusted runScript/);
  assert.match(help, /repeat\.times/);
  assert.match(help, /stopApp/);
  assert.match(help, /Unsupported syntax fails loudly/);
  assert.match(help, /issues\/558/);
});

test('usageForCommand includes Maestro test suite flag', () => {
  const help = usageForCommand('test');
  if (help === null) throw new Error('Expected test help text');
  assert.match(help, /Run one or more replay scripts as a serial test suite/);
  assert.match(help, /--maestro/);
  assert.match(help, /--record-video/);
  assert.match(help, /--shard-all <n>/);
  assert.match(help, /combine with --device id1,id2/);
  assert.match(help, /--shard-split <n>/);
  assert.match(help, /AD_SHARD_INDEX is zero-based/);
  assert.match(help, /Replay\/Test: inject or override/);
});

test('command help keeps scroll and gesture planning guidance', () => {
  const scrollHelp = usageForCommand('scroll');
  if (scrollHelp === null) throw new Error('Expected scroll help text');
  assert.match(scrollHelp, /Scroll in a direction/);
  assert.match(scrollHelp, /top\/bottom edge/);

  const gestureHelp = usageForCommand('gesture');
  if (gestureHelp === null) throw new Error('Expected gesture help text');
  assert.match(gestureHelp, /Android transform verification should use all app-observable effects/);
  assert.match(gestureHelp, /wait text "pan changed yes"/);
});

test('parseArgs recognizes test --record-video flag', () => {
  const parsed = parseArgs(['test', './suite', '--record-video'], { strictFlags: true });
  assert.equal(parsed.command, 'test');
  assert.equal(parsed.flags.recordVideo, true);
});

test('usageForCommand documents prepare ios-runner', () => {
  const help = usageForCommand('prepare');
  if (help === null) throw new Error('Expected prepare help text');
  assert.match(help, /Usage:\s+agent-device prepare ios-runner --platform ios\|macos/);
  assert.match(help, /Prepare platform helper infrastructure/);
  assert.match(help, /--timeout <ms>/);
  assert.match(help, /XCTest runner/);
  assert.match(help, /separate daemon/);
  assert.match(help, /clean:daemon after prepare/);
  assert.match(
    help,
    /not a recovery step for "runner already owned by another agent-device daemon"/,
  );
  assert.match(help, /Runner build\/start output is written to the session runner\.log/);
});

test('usageForCommand resolves workflow help topic', () => {
  const help = usageForCommand('workflow');
  if (help === null) throw new Error('Expected workflow help text');
  assert.match(help, /agent-device help workflow/);
  assert.match(help, /Use selectors as positional targets/);
  assert.match(help, /Do not use CSS selectors/);
  assert.match(help, /Snapshot legend:/);
  assert.match(help, /@e12 \[button\] label="Add to cart"/);
  assert.match(help, /Truncated text\/input previews: do not use get text first/);
  assert.match(help, /snapshot -s @e7/);
  assert.match(help, /Use plain fill\/type first for ordinary login and form fields/);
  assert.match(help, /--delay-ms intentionally paces character entry/);
  assert.match(help, /Read-only visible\/state question: use snapshot\/get\/is\/find/);
  assert.match(help, /Use snapshot -i only when refs are needed/);
  assert.match(help, /install-from-source --github-actions-artifact org\/repo:app-debug/);
  assert.match(help, /Discovery is not enough when the task asks to open\/start/);
  assert.match(help, /If the task says install, use install/);
  assert.match(help, /Do not open artifact paths or invent package ids/);
  assert.match(help, /agent-device get attrs @e4/);
  assert.match(help, /Ambiguous find: add --first or --last/);
  assert.match(help, /report that gap instead of typing\/searching\/navigating/);
  assert.match(help, /App-owned action sheets, menus, and camera\/scan screens are normal UI/);
  assert.match(help, /wait for a concrete result before returning to chat\/form state/);
  assert.match(help, /choose a point near the center of the intended app-owned target/);
  assert.match(help, /Avoid screen edges, tab bars, navigation bars, and home indicators/);
  assert.match(help, /Android transform injects a geometric two-finger path/);
  assert.match(help, /verify semantic app state or coarse per-component effects/);
  assert.match(help, /instead of exact numeric deltas/);
  assert.match(help, /prefer isolated gesture pan, gesture pinch, or gesture rotate/);
  assert.match(help, /longpress accepts coordinates, @refs, or selectors/);
  assert.match(help, /use help react-native for Metro\/Fast Refresh/);
  assert.match(help, /iOS Allow Paste prompt cannot be exercised under XCUITest/);
  assert.match(help, /Empty replacement is not a supported clear-field command/);
  assert.match(help, /do not plan fill <target> ""/);
  assert.match(help, /prefer keyboard dismiss before manually pressing visible Done/);
  assert.match(help, /UNSUPPORTED_OPERATION/);
  assert.match(help, /Stateful commands within one session must run serially/);
  assert.match(
    help,
    /Do not run open\/press\/fill\/type\/scroll\/back\/alert\/replay\/batch\/close commands in parallel/,
  );
  assert.match(help, /agent-device clipboard write "some text"/);
  assert.match(help, /For gesture-heavy iOS simulator proof videos, prefer --hide-touches/);
  assert.match(help, /only a means to reveal or reach an expected target/);
  assert.match(help, /using the id, selector, or text named by the task/);
  assert.match(
    help,
    /iOS simulator transform uses private XCTest synthesis for a continuous two-finger pan\/scale\/rotation path/,
  );
  assert.match(help, /Android Gboard handwriting\/stylus UI can capture text/);
  assert.match(help, /targetInput\/actualInput details/);
  assert.match(help, /Do not keep retrying fill\/type against the same field/);
  assert.match(help, /provider-native text injection when available/);
  assert.match(help, /Do not switch to raw adb, clipboard, or paste as an agent fallback/);
  assert.match(help, /if no URL is provided but a target\/app name is provided, open that target/);
  assert.match(help, /localhost\/127\.0\.0\.1\/\[::1\] with a port auto-configure/);
  assert.match(help, /Manual adb reverse tcp:<port> tcp:<port> is only needed/);
  assert.match(help, /do not stop at the action itself/);
  assert.match(help, /do not split clear\/restart/);
  assert.match(help, /do not write network log headers/);
  assert.match(help, /Web: agent-device uses a managed, pinned agent-browser backend/);
  assert.match(
    help,
    /Use --platform web when a browser step belongs inside an agent-device session/,
  );
  assert.match(help, /use agent-browser directly for standalone web automation/);
  assert.match(help, /agent-device web setup/);
  assert.match(help, /agent-device web doctor/);
  assert.match(help, /agent-device open https:\/\/example\.com --platform web/);
  assert.match(help, /agent-device get text @e2 --platform web/);
  assert.match(help, /agent-device is visible 'label="Welcome"' --platform web/);
  assert.match(help, /agent-device find text "Welcome" exists --platform web/);
  assert.match(help, /agent-device close --platform web/);
  assert.match(help, /Use agent-browser directly for browser-specific features/);
  assert.match(help, /agent-device open exp:\/\/127\.0\.0\.1:8081 --platform ios/);
  assert.match(help, /agent-device open "Expo Go" exp:\/\/127\.0\.0\.1:8081 --platform ios/);
  assert.match(help, /There is no open-url command/);
  assert.match(help, /direct URL open can report success while leaving the runner\/shell focused/);
  assert.match(help, /verify with snapshot -i after opening/);
  assert.match(help, /snapshot returns a sparse\/AX-unavailable state/);
  assert.match(help, /Use plain screenshot, not screenshot --overlay-refs/);
  assert.match(help, /retry snapshot -i after reaching another screen/);
  assert.match(help, /test \.\/e2e\/maestro --maestro --device udid1,emulator-5554 --shard-all 2/);
  assert.match(help, /agent-device open exp:\/\/127\.0\.0\.1:8081 --platform android/);
  assert.match(help, /apps lookup misses the project but shows Expo Go\/dev-client/);
  assert.match(help, /metro prepare --kind expo/);
  assert.match(help, /agent-device prepare ios-runner --platform ios --timeout 240000/);
  assert.match(help, /prepare ios-runner builds\/reuses the XCTest runner/);
  assert.match(
    help,
    /not a recovery step for "runner already owned by another agent-device daemon"/,
  );
  assert.match(help, /prepared runner does not keep a live lease/);
  assert.match(help, /help react-devtools/);
  assert.match(help, /help react-native/);
  assert.doesNotMatch(help, /agent-device react-devtools profile/);
});

test('usageForCommand resolves web help topic', () => {
  const help = usageForCommand('web');
  if (help === null) throw new Error('Expected web help text');
  assert.match(help, /agent-device help web/);
  assert.match(help, /agent-device uses a managed, pinned agent-browser backend/);
  assert.match(help, /agent-device owns command\/session\/replay integration/);
  assert.match(help, /agent-browser owns browser launch, page control, screenshots/);
  assert.match(
    help,
    /Use --platform web when a browser step belongs inside an agent-device session/,
  );
  assert.match(help, /Use agent-browser directly for standalone web automation/);
  assert.match(help, /agent-device web setup/);
  assert.match(help, /agent-device web doctor/);
  assert.match(help, /agent-device open https:\/\/example\.com --platform web/);
  assert.match(help, /agent-device snapshot -i --platform web/);
  assert.match(help, /agent-device get text @e2 --platform web/);
  assert.match(help, /agent-device is visible 'label="Welcome"' --platform web/);
  assert.match(help, /agent-device find text "Welcome" exists --platform web/);
  assert.match(help, /agent-device click @e12 --platform web/);
  assert.match(help, /agent-device fill @e13 "qa@example\.com" --platform web/);
  assert.match(help, /agent-device wait text "Welcome" 3000 --platform web/);
  assert.match(help, /agent-device network dump 25 --include headers --platform web/);
  assert.match(help, /agent-device screenshot \.\/artifacts\/web-home\.png --platform web/);
  assert.match(help, /agent-device close --platform web/);
  assert.match(help, /open <url>, snapshot -i, get text\/attrs/);
  assert.match(help, /is visible\/exists\/text, find text\/selector/);
  assert.match(help, /click\/press @ref or selector/);
  assert.match(help, /network dump/);
  assert.match(help, /network routing\/interception\/HAR/);
  assert.match(help, /Use agent-browser directly for those browser-specific workflows/);
  assert.match(help, /Do not claim web e2e CI exists/);
  assert.match(help, /Do not use native mobile or desktop setup commands/);
});

test('workflow help keeps common copyable command forms', () => {
  const help = usageForCommand('workflow');
  if (help === null) throw new Error('Expected workflow help text');
  assert.match(help, /network dump --include headers/);
  assert.match(help, /settings animations off/);
  assert.match(help, /connect --remote-config/);
  assert.match(help, /metro reload/);
  assert.match(help, /screenshot --overlay-refs/);
  assert.match(help, /snapshot -s @e7/);
  assert.match(help, /clipboard write "some text"/);
});

test('usageForCommand resolves debugging help topic', () => {
  const help = usageForCommand('debugging');
  if (help === null) throw new Error('Expected debugging help text');
  assert.match(help, /agent-device help debugging/);
  assert.match(help, /Use logs when you need the lead-up timeline/);
  assert.match(help, /Use debug symbols when you have crash\.ips\/crash\.log/);
  assert.match(help, /Use Xcode\/LLDB when you need live state/);
  assert.match(help, /debug symbols --artifact crash\.ips --search-path \.\/build/);
  assert.match(help, /Android Java\/R8 mapping\.txt and native ndk-stack\/addr2line/);
  assert.match(help, /agent-device alert wait 3000/);
  assert.match(help, /iOS support is runner-derived/);
  assert.match(help, /resolved app executable/);
  assert.match(help, /--launch-console is only for direct iOS simulator app launches/);
  assert.match(help, /runnerLogPath and requestLogPath/);
  assert.match(help, /requests\/<request-id>\.ndjson holds daemon request diagnostics/);
  assert.match(help, /daemon\.log is global daemon lifecycle evidence/);
  assert.match(help, /agent-device perf memory sample --json/);
  assert.match(help, /Memory artifact \(android-hprof\): \/tmp\/app\.hprof \(42MB\)/);
  assert.match(help, /Prefer perf memory sample over raw dumpsys\/leaks output/);
  assert.match(help, /Unsupported platforms return artifact\.available=false with reason\/hint/);
  assert.match(help, /Do not use settings permission to answer a dialog already on screen/);
  assert.match(help, /Treat native perf output as the agent evidence/);
  assert.match(help, /sizeBytes=5392410/);
  assert.match(help, /5\.3 MB raw trace stays in the artifact/);
});

test('parseArgs recognizes debug symbols command shape', () => {
  const parsed = parseArgs([
    'debug',
    'symbols',
    '--artifact',
    'crash.ips',
    '--search-path',
    './build',
    '--out',
    'crash-symbolicated.ips',
  ]);

  assert.equal(parsed.command, 'debug');
  assert.deepEqual(parsed.positionals, ['symbols']);
  assert.equal(parsed.flags.artifact, 'crash.ips');
  assert.equal(parsed.flags.searchPath, './build');
  assert.equal(parsed.flags.out, 'crash-symbolicated.ips');
});

test('debug command help stays scoped to symbolication', () => {
  const help = usageForCommand('debug');
  if (help === null) throw new Error('Expected debug help text');
  assert.match(help, /debug symbols --artifact/);
  assert.match(help, /intentionally narrow/);
  assert.match(help, /use logs for app logs, network for HTTP evidence, perf for performance/);
  assert.doesNotMatch(help, /agent-device debug perf/);
  assert.doesNotMatch(help, /agent-device debug logs/);
});

test('debug rejects unrelated diagnostics flags', () => {
  assert.throws(
    () => parseArgs(['debug', 'symbols', '--include', 'headers']),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('not supported for command debug'),
  );
});

test('usageForCommand resolves remote help topic', () => {
  const help = usageForCommand('remote');
  if (help === null) throw new Error('Expected remote help text');
  assert.match(help, /agent-device connect/);
  assert.match(help, /Remote connection providers use the same lifecycle/);
  assert.match(help, /connect -> open -> commands -> close -> disconnect/);
  assert.match(help, /Direct proxy: agent-device connect proxy/);
  assert.match(help, /stores the shared proxy profile and client identity/);
  assert.match(help, /agent-device open com\.example\.app --remote-config \.\/remote-config\.json/);
  assert.match(help, /disconnect --remote-config \.\/remote-config\.json/);
  assert.match(help, /Script flow, per-command config/);
  assert.match(help, /Direct proxy flow for a remote Mac/);
  assert.match(help, /agent-device proxy --port 4310/);
  assert.match(
    help,
    /connect proxy --daemon-base-url https:\/\/example\.trycloudflare\.com\/agent-device --daemon-auth-token <token>/,
  );
  assert.match(help, /agent-device open Maps --platform ios/);
  assert.match(help, /agent-device snapshot -i --platform ios/);
  assert.match(help, /agent-device close/);
  assert.match(help, /Device leases are acquired on open/);
  assert.match(help, /expire after five minutes without commands/);
  assert.match(help, /Multiple agents can share one proxy/);
  assert.match(help, /disconnect releases local connection state/);
  assert.match(help, /A busy direct-proxy device error means another agent owns the device/);
  assert.match(help, /local\/proxy iOS reports that the runner is already owned/);
  assert.match(help, /same --remote-config to every operational command/);
  assert.match(help, /Do not use --config as a remote profile flag/);
  assert.match(help, /install-from-source --github-actions-artifact org\/repo:artifact/);
});

test('usageForCommand resolves physical-device help topic', () => {
  const help = usageForCommand('physical-device');
  if (help === null) throw new Error('Expected physical-device help text');
  assert.match(help, /agent-device help physical-device/);
  assert.match(help, /Start with Automatic Signing and only these env vars/);
  assert.match(help, /AGENT_DEVICE_IOS_TEAM_ID=ABCDE12345/);
  assert.match(help, /AGENT_DEVICE_IOS_BUNDLE_ID=com\.yourname\.agentdevice\.runner/);
  assert.match(help, /profile name\/specifier, not a file path/);
});

test('usageForCommand resolves macos help topic', () => {
  const help = usageForCommand('macos');
  if (help === null) throw new Error('Expected macos help text');
  assert.match(help, /agent-device click @e66 --button secondary --platform macos/);
  assert.match(help, /Context menus are not ambient UI/);
  assert.match(help, /menu-item refs/);
});

test('usageForCommand resolves dogfood help topic', () => {
  const help = usageForCommand('dogfood');
  if (help === null) throw new Error('Expected dogfood help text');
  assert.match(help, /agent-device help dogfood/);
  assert.match(help, /Find user-visible issues from runtime behavior/);
  assert.match(help, /Severity: critical blocks a core flow\/data\/crashes/);
  assert.match(help, /Interactive\/behavioral issues need step screenshots/);
  assert.match(help, /Static\/on-load issues can use one screenshot/);
  assert.match(help, /React Native warning\/error overlays can be real findings/);
  assert.match(help, /Expo Go\/dev-client shells/);
  assert.match(help, /direct Android localhost URL opens with a port auto-configure/);
  assert.match(help, /Keep stateful commands serial within the same session/);
  assert.match(help, /prefer agent-device open "Expo Go" <url>/);
  assert.match(help, /dogfood-output\/report\.md/);
  assert.match(help, /ID, severity, category, title, affected flow\/screen/);
  assert.match(help, /Never delete screenshots, videos, traces, or report artifacts/);
  assert.match(help, /screenshot \.\/dogfood-output\/screenshots\/issue-001\.png --overlay-refs/);
});

test('usageForCommand resolves react-devtools help topic', () => {
  const help = usageForCommand('react-devtools');
  if (help === null) throw new Error('Expected react-devtools help text');
  assert.match(help, /agent-device react-devtools start/);
  assert.match(help, /agent-device react-devtools wait --component <ComponentName>/);
  assert.match(help, /agent-device react-devtools find <ComponentName> --exact/);
  assert.match(help, /agent-device react-devtools errors/);
  assert.match(help, /agent-device react-devtools profile report @c5/);
  assert.match(help, /agent-device react-devtools profile timeline --limit 20/);
  assert.match(help, /agent-device react-devtools profile export profile\.json/);
  assert.match(
    help,
    /agent-device react-devtools profile diff before\.json after\.json --limit 10/,
  );
  assert.match(help, /render causes and changed props\/state\/hooks/);
  assert.match(help, /Run agent-device react-devtools status first/);
  assert.match(help, /start is not a connection check/);
  assert.match(help, /Always run agent-device react-devtools wait --connected after status/);
  assert.match(help, /logs clear --restart before the first logs mark/);
  assert.match(help, /one bounded first-pass survey/);
  assert.match(help, /profile slow --limit 5 once/);
  assert.match(help, /profile rerenders --limit 5 once/);
  assert.match(help, /profile timeline --limit 20 only when commit timing matters/);
  assert.match(help, /Do not repeatedly raise broad profile slow limits/);
  assert.match(help, /profile report unless you have a specific target/);
  assert.match(help, /agent-device logs mark "before catalog search"/);
  assert.match(help, /agent-device react-devtools profile timeline --limit 20/);
  assert.match(help, /Do not write agent-devtools/);
  assert.match(help, /Every profiling and survey line must begin with agent-device react-devtools/);
  assert.match(help, /agent-device network dump --include headers/);
  assert.match(help, /@c refs reset after reload\/remount/);
  assert.match(help, /use separate sessions\/devices/);
  assert.match(help, /local service tunnel/);
  assert.match(help, /Remote iOS apps attempt the legacy React DevTools websocket/);
});

test('usageForCommand resolves cdp help topic', () => {
  const help = usageForCommand('cdp');
  if (help === null) throw new Error('Expected cdp help text');
  assert.match(help, /agent-device cdp target list --url http:\/\/127\.0\.0\.1:8081/);
  assert.match(help, /memory usage sample --label baseline --gc/);
  assert.match(help, /memory snapshot leak-triplet --baseline ms_1 --action ms_2 --cleanup ms_3/);
  assert.match(help, /memory snapshot retainers --snapshot ms_3 --id <node-id>/);
  assert.match(help, /Until cdp has a compact leak report command/);
  assert.match(help, /Avoid cdp profile cpu, trace, network, and console by default/);
  assert.match(help, /React Native\/Hermes implements a subset of browser CDP/);
});

test('usageForCommand resolves react-native help topic', () => {
  const help = usageForCommand('react-native');
  if (help === null) throw new Error('Expected react-native help text');
  assert.match(help, /agent-device help react-native/);
  assert.match(help, /React Native-specific automation hazards/);
  assert.match(help, /Choose the next help topic/);
  assert.match(help, /help workflow/);
  assert.match(help, /help debugging/);
  assert.match(help, /help react-devtools/);
  assert.match(help, /Help workflow owns the full Expo URL command shapes/);
  assert.match(help, /For app\/package launches, run metro prepare/);
  assert.match(help, /same host context that owns Metro/);
  assert.match(help, /sandbox probe is not authoritative/);
  assert.match(help, /adb reverse only affects Android device-to-host traffic/);
  assert.match(help, /Multiple local worktrees can reuse one native iOS simulator build/);
  assert.match(help, /--metro-host 127\.0\.0\.1 --metro-port 8081/);
  assert.match(help, /One simulator cannot run two copies of the same bundle id/);
  assert.match(help, /Keep the agent-device react-devtools prefix/);
  assert.match(help, /Use help react-devtools for status\/wait/);
  assert.match(help, /Keep the agent-device cdp prefix/);
  assert.match(help, /Use help cdp for JS heap usage samples/);
  assert.match(help, /logs clear --restart/);
  assert.match(help, /network dump --include headers/);
  assert.match(help, /agent-device open "Agent Device Tester" --platform android/);
  assert.match(help, /Start React Native slow-flow plans with this ordered scaffold/);
  assert.match(help, /include the open command even when it also describes the current screen/);
  assert.match(help, /agent-device react-devtools status/);
  assert.match(help, /Profiling plans need both status and wait --connected before profile start/);
  assert.match(help, /Do not substitute react-devtools start for status/);
  assert.match(help, /If snapshot reports a React Native warning\/error overlay/);
  assert.match(help, /agent-device react-native dismiss-overlay/);
  assert.match(help, /verifies the overlay is gone with a fresh post-dismiss snapshot -i/);
  assert.match(help, /Do not use a plain snapshot after dismiss-overlay/);
  assert.match(help, /When overlay evidence and React diagnostics are required/);
  assert.match(help, /agent-device react-devtools errors/);
  assert.match(help, /overlay is still visible/);
  assert.match(help, /Do not manually press warning\/error text bodies/);
  assert.match(help, /dismiss-overlay command owns the narrow LogBox\/RedBox targeting policy/);
  assert.match(help, /Android runtime permission dialogs and native alerts are handled by alert/);
  assert.match(help, /snapshot times out because the UI never becomes idle/);
  assert.match(help, /Report React render offenders separately/);
});

test('apps defaults to user-installed filter and allows overrides', () => {
  const defaultFilter = parseArgs(['apps'], { strictFlags: true });
  assert.equal(defaultFilter.command, 'apps');
  assert.equal(defaultFilter.flags.appsFilter, 'user-installed');

  const allApps = parseArgs(['apps', '--all'], { strictFlags: true });
  assert.equal(allApps.command, 'apps');
  assert.equal(allApps.flags.appsFilter, 'all');

  assert.throws(
    () => parseArgs(['apps', '--user-installed'], { strictFlags: true }),
    /Unknown flag: --user-installed/,
  );
});

const INTERNAL_GESTURE_CAPABILITY_COMMANDS = new Set([
  'pan',
  'fling',
  'pinch',
  'rotate-gesture',
  'transform-gesture',
]);

test('every public capability command has a parser schema entry', () => {
  const schemaCommands = new Set<string>(listCliCommandNames());
  for (const command of listCapabilityCommands()) {
    if (INTERNAL_GESTURE_CAPABILITY_COMMANDS.has(command)) continue;
    assert.equal(schemaCommands.has(command), true, `Missing schema for command: ${command}`);
  }
});

test('every CLI command has a derived or local parser schema entry', () => {
  for (const command of listCliCommandNames()) {
    assert.doesNotThrow(
      () => getCliCommandSchema(command),
      `Missing schema for command: ${command}`,
    );
  }
});

test('schema capability mappings match capability source-of-truth', () => {
  assert.deepEqual(
    listCapabilityCheckedCommandNames(),
    listCapabilityCommands().filter(
      (command) => !INTERNAL_GESTURE_CAPABILITY_COMMANDS.has(command),
    ),
  );
});

test('compat mode warns and strips unsupported command flags', () => {
  const parsed = parseArgs(['press', '10', '20', '--pause-ms', '2'], { strictFlags: false });
  assert.equal(parsed.command, 'press');
  assert.equal(parsed.flags.pauseMs, undefined);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0]!, /not supported for command press/);
});

test('strict mode rejects unsupported pilot-command flags', () => {
  assert.throws(
    () => parseArgs(['press', '10', '20', '--pause-ms', '2'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('not supported for command press'),
  );
});

test('strict mode rejects removed secondary alias', () => {
  assert.throws(
    () => parseArgs(['click', '@e5', '--secondary'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown flag: --secondary',
  );
});

test('strict mode rejects click-only button flag on press', () => {
  assert.throws(
    () => parseArgs(['press', '10', '20', '--button', 'secondary'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('not supported for command press'),
  );
});

test('snapshot command accepts command-specific flags', () => {
  const ignoredLegacyFlag = '-' + 'c';
  const parsed = parseArgs(
    ['snapshot', '-i', ignoredLegacyFlag, '--depth', '3', '-s', 'Login', '--timeout', '120000'],
    {
      strictFlags: true,
    },
  );
  assert.equal(parsed.command, 'snapshot');
  assert.equal(parsed.flags.snapshotInteractiveOnly, true);
  assert.equal(parsed.flags.snapshotDepth, 3);
  assert.equal(parsed.flags.snapshotScope, 'Login');
  assert.equal(parsed.flags.timeoutMs, 120000);
});

test('snapshot command accepts diff alias flag', () => {
  const parsed = parseArgs(['snapshot', '--diff', '-i', '--depth', '4', '--scope', 'Counter'], {
    strictFlags: true,
  });
  assert.equal(parsed.command, 'diff');
  assert.deepEqual(parsed.positionals, ['snapshot']);
  assert.equal(parsed.flags.snapshotDiff, undefined);
  assert.equal(parsed.flags.snapshotInteractiveOnly, true);
  assert.equal(parsed.flags.snapshotDepth, 4);
  assert.equal(parsed.flags.snapshotScope, 'Counter');
});

test('snapshot --diff --help stays on snapshot command help', () => {
  const parsed = parseArgs(['snapshot', '--diff', '--help'], { strictFlags: true });
  assert.equal(parsed.command, 'snapshot');
  assert.equal(parsed.flags.snapshotDiff, true);
  assert.equal(parsed.flags.help, true);
});

test('diff snapshot command accepts snapshot flags', () => {
  const parsed = parseArgs(
    ['diff', 'snapshot', '-i', '--depth', '4', '--scope', 'Counter', '--raw'],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'diff');
  assert.deepEqual(parsed.positionals, ['snapshot']);
  assert.equal(parsed.flags.snapshotInteractiveOnly, true);
  assert.equal(parsed.flags.snapshotDepth, 4);
  assert.equal(parsed.flags.snapshotScope, 'Counter');
  assert.equal(parsed.flags.snapshotRaw, true);
});

test('unknown short flags are rejected', () => {
  assert.throws(
    () => parseArgs(['press', '10', '20', '-x'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown flag: -x',
  );
});

test('negative numeric positionals are accepted without -- separator', () => {
  const typed = parseArgs(['type', '-123'], { strictFlags: true });
  assert.equal(typed.command, 'type');
  assert.deepEqual(typed.positionals, ['-123']);

  const typedMulti = parseArgs(['type', '-123', '-456'], { strictFlags: true });
  assert.equal(typedMulti.command, 'type');
  assert.deepEqual(typedMulti.positionals, ['-123', '-456']);

  const pressed = parseArgs(['press', '-10', '20'], { strictFlags: true });
  assert.equal(pressed.command, 'press');
  assert.deepEqual(pressed.positionals, ['-10', '20']);
});

test('command-specific flags without command fail in strict mode', () => {
  assert.throws(
    () => parseArgs(['--depth', '3'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('requires a command that supports it'),
  );
});

test('command-specific flags without command warn and strip in compat mode', () => {
  const parsed = parseArgs(['--depth', '3'], { strictFlags: false });
  assert.equal(parsed.command, null);
  assert.equal(parsed.flags.snapshotDepth, undefined);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0]!, /requires a command that supports/);
});

test('all commands participate in strict command-flag validation', () => {
  assert.throws(
    () => parseArgs(['open', 'Settings', '--depth', '1'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('not supported for command open'),
  );
});

test('invalid range errors are deterministic', () => {
  assert.throws(
    () => parseArgs(['snapshot', '--backend', 'xctest'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Unknown flag: --backend',
  );
  assert.throws(
    () => parseArgs(['snapshot', '--depth', '-1'], { strictFlags: true }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message === 'Invalid depth: -1',
  );
});

test('usage includes swipe and press series options', () => {
  const help = usage();
  assert.match(help, /diff <kind>/);
  assert.match(help, /swipe <x1> <y1> <x2> <y2>/);
  assert.match(help, /settings \[area\] \[options\]/);
  assert.doesNotMatch(help, /--pattern one-way\|ping-pong/);
  assert.doesNotMatch(help, /--interval-ms/);
});

test('usage renders concise commands inline with descriptions', () => {
  const help = usage();
  assert.match(help, /Commands:[\s\S]*\n  boot\s{2,}Boot target device\/simulator/);
  assert.match(help, /Commands:[\s\S]*\n  shutdown\s{2,}Shutdown target simulator\/emulator/);
  assert.match(help, /  prepare\s{2,}Pre-warm platform helpers/);
  assert.match(help, /  metro\s{2,}Prepare Metro reachability for React Native\/Expo apps/);
  assert.match(help, /  perf\s{2,}Check runtime metrics, frames, memory, CPU profiles/);
  assert.match(help, /  cdp\s{2,}Inspect React Native CDP targets, JS heap growth/);
  assert.match(help, /  react-devtools\s{2,}Inspect React Native components, props, hooks/);
  assert.match(help, /  proxy\s{2,}Expose a local daemon through cloudflared, ngrok/);
  assert.match(help, /  batch --steps <json> \| --steps-file <path>\s{2,}Run multiple commands/);
  assert.match(help, /  test <path-or-glob>\.\.\.\s{2,}Run replay test suites/);
  assert.match(
    help,
    /  screenshot \[path\]\s{2,}Capture screenshot with optional web full-page, desktop/,
  );
  assert.match(
    help,
    /  session\s{2,}List active sessions or print the effective daemon state directory/,
  );
  assert.doesNotMatch(help, /  metro prepare[^\n]*--project-root/);
  assert.doesNotMatch(help, /\n  batch\s{2,}Run multiple commands/);
  assert.doesNotMatch(help, /agent-device-proxy/);
});

test('proxy command help describes tunnel usage', () => {
  const help = usageForCommand('proxy');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Usage:\s+agent-device proxy/);
  assert.match(help, /cloudflared tunnel --url http:\/\/127\.0\.0\.1:4310/);
  assert.match(help, /--host <host>\s+Proxy: host interface to bind/);
  assert.match(help, /--port <port>\s+Proxy: TCP port to bind/);
  assert.match(help, /--daemon-auth-token <token>\s+Remote HTTP daemon or proxy auth token/);
  assert.match(help, /--state-dir <path>\s+Daemon state directory/);
  assert.match(help, /\/agent-device\/\*/);
  assert.match(help, /https:\/\/example\.trycloudflare\.com\/agent-device/);
  assert.match(help, /does not use agent-device auth/);
  assert.doesNotMatch(help, /agent-device-proxy/);
});

test('connect command help lists lease id in usage and flags', () => {
  const help = usageForCommand('connect');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Usage:\s+agent-device connect .*--daemon-base-url <url>/);
  assert.match(help, /--daemon-base-url <url>\s+Explicit remote HTTP daemon base URL/);
  assert.match(help, /Usage:\s+agent-device connect .*--lease-id <id>/);
  assert.match(help, /--lease-id <id>\s+Lease identifier bound to tenant\/run admission scope/);
  assert.doesNotMatch(help, /--project-root <path>/);
  assert.doesNotMatch(help, /--public-base-url <url>/);
  assert.doesNotMatch(help, /--launch-url <url>/);
});

test('install-from-source command help describes all source types', () => {
  const help = usageForCommand('install-from-source');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Install app builds from URLs, remote source specs, or CI artifacts/);
});

test('session command help includes daemon state directory discovery', () => {
  const help = usageForCommand('session');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Usage:\s+agent-device session list \| session state-dir/);
  assert.match(help, /effective daemon state directory/);
});

test('web command help includes managed backend setup', () => {
  const help = usageForCommand('web');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /agent-device help web/);
  assert.match(help, /managed, pinned agent-browser backend/);
  assert.match(
    help,
    /agent-device web setup[\s\S]*agent-device open https:\/\/example\.com --platform web/,
  );
  assert.match(help, /Before first use, set up and verify the managed backend/);
  assert.doesNotMatch(help, /do not install the backend implicitly/);
  assert.doesNotMatch(help, /web status/);
});

test('command usage describes test suite flags', () => {
  const help = usageForCommand('test');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Usage:\s+agent-device test <path-or-glob>\.\.\./);
  assert.match(help, /Run one or more replay scripts as a serial test suite/);
  assert.match(help, /--maestro/);
  assert.match(help, /--fail-fast/);
  assert.match(help, /each shard stops independently/);
  assert.match(help, /--timeout <ms>/);
  assert.match(help, /--retries <n>/);
  assert.match(help, /--record-video/);
  assert.match(help, /--artifacts-dir <path>/);
  assert.doesNotMatch(help, /test --verbose prints per-test step timings without debug logs/);
});

test('command usage describes delayed typing flags', () => {
  const typeHelp = usageForCommand('type');
  const fillHelp = usageForCommand('fill');
  if (typeHelp === null || fillHelp === null) {
    throw new Error('Expected command help text');
  }
  assert.match(typeHelp, /--delay-ms <ms>/);
  assert.match(fillHelp, /--delay-ms <ms>/);
});

test('snapshot command usage documents diff alias', () => {
  const help = usageForCommand('snapshot');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /agent-device snapshot \[--diff\]/);
  assert.match(help, /--timeout <ms>/);
  assert.match(help, /Capture accessibility tree or diff against the previous session baseline/);
  assert.match(help, /inspect rects with snapshot -i --json/);
  assert.match(help, /verify with diff snapshot -i or snapshot --diff/);
});

test('network command usage documents include flag', () => {
  const help = usageForCommand('network');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /--include summary\|headers\|body\|all/);
});

test('command usage shows command flags without global flags', () => {
  const help = usageForCommand('swipe');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Swipe coordinates with optional repeat pattern/);
  assert.match(help, /Command flags:/);
  assert.match(help, /--pattern one-way\|ping-pong/);
  assert.doesNotMatch(help, /Global flags:/);
  assert.doesNotMatch(help, /Global Flags:/);
  assert.doesNotMatch(help, /--platform ios\|macos\|android\|linux\|web\|apple/);
});

test('back command usage documents explicit mode flags', () => {
  const help = usageForCommand('back');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /agent-device back \[--in-app\|--system\]/);
  assert.match(help, /--in-app/);
  assert.match(help, /--system/);
});

test('open command usage documents surface and console log flags', () => {
  const help = usageForCommand('open');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /--surface app\|frontmost-app\|desktop\|menubar/);
  assert.match(help, /macOS also supports --surface/);
  assert.match(help, /--launch-console <path>/);
  assert.match(help, /iOS simulator launch console/);
  assert.match(help, /--device-hub/);
  assert.match(help, /use Xcode Device Hub/);
  assert.match(help, /Use --platform to bind URL\/deep-link opens/);
  assert.match(help, /agent-device open "Expo Go" exp:\/\/127\.0\.0\.1:8081 --platform ios/);
});

test('replay command usage keeps Maestro target binding guidance', () => {
  const help = usageForCommand('replay');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /For Maestro YAML compatibility flows/);
  assert.match(help, /replay <flow\.yaml> --maestro/);
  assert.match(help, /--platform ios/);
});

test('command usage shows record touch-overlay opt-out flag', () => {
  const help = usageForCommand('record');
  if (help === null) throw new Error('Expected command help text');
  assert.match(
    help,
    /record start \[path\] \[--fps <n>\] \[--max-size <px>\] \[--quality <medium\|high>\] \[--hide-touches\] \| record stop/,
  );
  assert.match(help, /--max-size <px>/);
  assert.match(help, /--quality <medium\|high>/);
  assert.match(help, /--hide-touches/);
  assert.match(help, /skip touch-overlay post-processing/);
  assert.match(help, /multiple MP4 chunks/);
});

test('command usage keeps detailed descriptions', () => {
  const help = usageForCommand('metro');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Prepare a local Metro runtime or ask Metro to reload/);
  assert.match(help, /metro reload/);
  assert.match(help, /--metro-host <host>/);
  assert.match(help, /AGENT_DEVICE_METRO_BEARER_TOKEN/);
});

test('command usage shows no command flags when unsupported', () => {
  const help = usageForCommand('appstate');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /Show foreground app\/activity/);
  assert.doesNotMatch(help, /Command flags:/);
  assert.doesNotMatch(help, /Global flags:/);
  assert.doesNotMatch(help, /Global Flags:/);
});

test('clipboard command usage is documented', () => {
  const help = usageForCommand('clipboard');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /clipboard read \| clipboard write <text>/);
  assert.match(help, /Read or write device clipboard text/);
});

test('keyboard command usage is documented', () => {
  const help = usageForCommand('keyboard');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /keyboard \[status\|get\|dismiss\|enter\|return\]/);
  assert.match(
    help,
    /Inspect Android keyboard visibility\/type or press\/dismiss the device keyboard/,
  );
});

test('rotate command usage is documented', () => {
  const help = usageForCommand('rotate');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /rotate <portrait\|portrait-upside-down\|landscape-left\|landscape-right>/);
  assert.match(help, /Rotate device orientation on iOS and Android/);
});

test('settings usage documents canonical faceid states', () => {
  const help = usageForCommand('settings');
  if (help === null) throw new Error('Expected command help text');
  assert.match(help, /location set <lat> <lon>/);
  assert.match(help, /clear-app-state \[app-id\]/);
  assert.match(help, /light\|dark\|toggle/);
  assert.match(help, /match\|nonmatch\|enroll\|unenroll/);
  assert.match(
    help,
    /camera\|microphone\|photos\|contacts\|contacts-limited\|notifications\|calendar\|location\|location-always\|media-library\|motion\|reminders\|siri/,
  );
  assert.doesNotMatch(help, /validate\|unvalidate/);
});

test('removed trigger aliases are no longer documented as commands', () => {
  const help = usageForCommand('trigger-screenshot-notification');
  assert.equal(help, null);
});
