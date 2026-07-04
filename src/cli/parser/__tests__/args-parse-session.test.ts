import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseArgs } from '../args.ts';

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
      label: 'doctor android',
      argv: ['doctor', '--platform', 'android', '--app', 'com.example.demo'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'doctor');
        assert.equal(parsed.flags.platform, 'android');
        assert.equal(parsed.flags.targetApp, 'com.example.demo');
      },
    },
    {
      label: 'doctor remote session',
      argv: ['doctor', '--remote', '--session', 'remote-ios', '--remote-config', './remote.json'],
      strictFlags: true,
      assertParsed: (parsed) => {
        assert.equal(parsed.command, 'doctor');
        assert.equal(parsed.flags.remote, true);
        assert.equal(parsed.flags.session, 'remote-ios');
        assert.equal(parsed.flags.remoteConfig, './remote.json');
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
        '--reporter',
        'default',
        '--reporter',
        'junit:.agent-device/test-artifacts/junit.xml',
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
        assert.deepEqual(parsed.flags.reporter, [
          'default',
          'junit:.agent-device/test-artifacts/junit.xml',
        ]);
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

test('parseArgs preserves connect cloud provider positional', () => {
  const parsed = parseArgs(['connect', 'cloud'], { strictFlags: true });
  assert.equal(parsed.command, 'connect');
  assert.deepEqual(parsed.positionals, ['cloud']);
});

test('parseArgs recognizes connect browserstack provider flags', () => {
  const parsed = parseArgs(
    [
      'connect',
      'browserstack',
      '--platform',
      'android',
      '--device',
      'Google Pixel 8',
      '--provider-os-version',
      '14.0',
      '--provider-app',
      'bs://app-id',
      '--provider-project',
      'agent-device',
      '--provider-build',
      'build-a',
      '--provider-session-name',
      'session-a',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'connect');
  assert.deepEqual(parsed.positionals, ['browserstack']);
  assert.equal(parsed.flags.providerApp, 'bs://app-id');
  assert.equal(parsed.flags.providerOsVersion, '14.0');
  assert.equal(parsed.flags.providerProject, 'agent-device');
  assert.equal(parsed.flags.providerBuild, 'build-a');
  assert.equal(parsed.flags.providerSessionName, 'session-a');
});

test('parseArgs recognizes connect aws-device-farm provider flags', () => {
  const parsed = parseArgs(
    [
      'connect',
      'aws-device-farm',
      '--platform',
      'ios',
      '--aws-project-arn',
      'project-arn',
      '--aws-device-arn',
      'device-arn',
      '--aws-app-arn',
      'app-arn',
      '--aws-region',
      'us-west-2',
      '--aws-interaction-mode',
      'INTERACTIVE',
    ],
    { strictFlags: true },
  );
  assert.equal(parsed.command, 'connect');
  assert.deepEqual(parsed.positionals, ['aws-device-farm']);
  assert.equal(parsed.flags.awsProjectArn, 'project-arn');
  assert.equal(parsed.flags.awsDeviceArn, 'device-arn');
  assert.equal(parsed.flags.awsAppArn, 'app-arn');
  assert.equal(parsed.flags.awsRegion, 'us-west-2');
  assert.equal(parsed.flags.awsInteractionMode, 'INTERACTIVE');
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

test('parseArgs supports metrics alias for perf', () => {
  const parsed = parseArgs(['metrics'], { strictFlags: true });
  assert.equal(parsed.command, 'perf');
  assert.deepEqual(parsed.positionals, []);
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
