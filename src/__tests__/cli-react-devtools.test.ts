import fs from 'node:fs';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';

vi.mock('../utils/exec.ts', () => ({
  runCmdStreaming: vi.fn(),
}));

vi.mock('../client/client-react-devtools-companion.ts', () => ({
  ensureReactDevtoolsCompanion: vi.fn(),
  stopReactDevtoolsCompanion: vi.fn(),
}));

import { runCmdStreaming } from '../utils/exec.ts';
import {
  ensureReactDevtoolsCompanion,
  stopReactDevtoolsCompanion,
} from '../client/client-react-devtools-companion.ts';
import {
  AGENT_REACT_DEVTOOLS_PACKAGE,
  buildReactDevtoolsNpmExecArgs,
  runReactDevtoolsCommand,
} from '../cli/commands/react-devtools.ts';

type ReactDevtoolsOptions = NonNullable<Parameters<typeof runReactDevtoolsCommand>[1]>;
type ReactDevtoolsFlags = NonNullable<ReactDevtoolsOptions['flags']>;

const remoteBridgeScope = {
  metroProxyBaseUrl: 'https://bridge.example.test',
  metroBearerToken: 'token',
  tenant: 'tenant-1',
  runId: 'run-1',
  leaseId: 'lease-1',
} as const;

const remoteBridgeBackends = [
  { label: 'Android', leaseBackend: 'android-instance' },
  { label: 'iOS', leaseBackend: 'ios-instance' },
] as const;

afterEach(() => {
  vi.clearAllMocks();
});

test('react-devtools passthrough pins agent-react-devtools package version', () => {
  assert.equal(AGENT_REACT_DEVTOOLS_PACKAGE, 'agent-react-devtools@0.4.0');
  assert.deepEqual(buildReactDevtoolsNpmExecArgs(['get', 'tree', '--depth', '3']), [
    'exec',
    '--yes',
    '--package',
    'agent-react-devtools@0.4.0',
    '--',
    'agent-react-devtools',
    'get',
    'tree',
    '--depth',
    '3',
  ]);
});

test('react-devtools docs mention the pinned package version', () => {
  const docs = ['website/docs/docs/commands.md'];

  for (const file of docs) {
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(AGENT_REACT_DEVTOOLS_PACKAGE));
  }
});

function mockRemoteCompanionSuccess(): void {
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  vi.mocked(ensureReactDevtoolsCompanion).mockResolvedValueOnce({
    pid: 123,
    spawned: true,
    statePath: '/tmp/state.json',
    logPath: '/tmp/companion.log',
  });
}

function assertNoRemoteCompanion(): void {
  assert.equal(vi.mocked(ensureReactDevtoolsCompanion).mock.calls.length, 0);
  assert.equal(vi.mocked(stopReactDevtoolsCompanion).mock.calls.length, 0);
}

async function runStatusWithoutCompanion(flags: ReactDevtoolsFlags): Promise<void> {
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({
    exitCode: 0,
    stdout: '',
    stderr: '',
  });

  await runReactDevtoolsCommand(['status'], {
    stateDir: '/tmp/agent-device-state',
    session: 'default',
    flags,
  });

  assertNoRemoteCompanion();
}

function assertRemoteCompanionStarted(env: NodeJS.ProcessEnv): void {
  assert.equal(vi.mocked(ensureReactDevtoolsCompanion).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(ensureReactDevtoolsCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/project',
    stateDir: '/tmp/agent-device-state',
    serverBaseUrl: 'https://bridge.example.test',
    bearerToken: 'token',
    bridgeScope: {
      tenantId: 'tenant-1',
      runId: 'run-1',
      leaseId: 'lease-1',
    },
    session: 'default',
    profileKey: '/tmp/remote.json',
    consumerKey: 'default',
    env,
  });
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[0], 'npm');
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[2]?.cwd, '/tmp/project');
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[2]?.env, env);
  assert.equal(vi.mocked(stopReactDevtoolsCompanion).mock.calls.length, 0);
}

for (const { label, leaseBackend } of remoteBridgeBackends) {
  test(`react-devtools keeps remote ${label} companion after passthrough command`, async () => {
    const env = { ...process.env };
    mockRemoteCompanionSuccess();

    const exitCode = await runReactDevtoolsCommand(['status'], {
      stateDir: '/tmp/agent-device-state',
      session: 'default',
      cwd: '/tmp/project',
      env,
      flags: {
        ...remoteBridgeScope,
        leaseBackend,
        remoteConfig: '/tmp/remote.json',
        session: 'default',
      },
    });

    assert.equal(exitCode, 0);
    assertRemoteCompanionStarted(env);
  });
}

test('react-devtools wait hints to relaunch remote iOS after startup-time connection misses', async () => {
  const env = { ...process.env };
  let stderr = '';
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({
    exitCode: 1,
    stdout: '',
    stderr: '',
  });
  vi.mocked(ensureReactDevtoolsCompanion).mockResolvedValueOnce({
    pid: 123,
    spawned: true,
    statePath: '/tmp/state.json',
    logPath: '/tmp/companion.log',
  });

  try {
    const exitCode = await runReactDevtoolsCommand(['wait', '--connected'], {
      stateDir: '/tmp/agent-device-state',
      session: 'default',
      cwd: '/tmp/project',
      env,
      flags: {
        ...remoteBridgeScope,
        leaseBackend: 'ios-instance',
        remoteConfig: '/tmp/remote.json',
        session: 'default',
      },
    });

    assert.equal(exitCode, 1);
    assert.match(stderr, /Remote iOS React DevTools connects during JavaScript startup/);
    assert.match(stderr, /open <bundle-id> --platform ios --relaunch/);
  } finally {
    process.stderr.write = originalStderrWrite;
  }
});

test('react-devtools stop cleans up remote companion', async () => {
  const env = { ...process.env };
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({
    exitCode: 0,
    stdout: '',
    stderr: '',
  });
  vi.mocked(stopReactDevtoolsCompanion).mockResolvedValueOnce({
    stopped: true,
    statePath: '/tmp/state.json',
  });

  const exitCode = await runReactDevtoolsCommand(['stop'], {
    stateDir: '/tmp/agent-device-state',
    session: 'default',
    cwd: '/tmp/project',
    env,
    flags: {
      ...remoteBridgeScope,
      leaseBackend: 'ios-instance',
      remoteConfig: '/tmp/remote.json',
      session: 'default',
    },
  });

  assert.equal(exitCode, 0);
  assert.equal(vi.mocked(ensureReactDevtoolsCompanion).mock.calls.length, 0);
  assert.equal(vi.mocked(runCmdStreaming).mock.calls[0]?.[0], 'npm');
  assert.deepEqual(vi.mocked(runCmdStreaming).mock.calls[0]?.[1], [
    'exec',
    '--yes',
    '--package',
    'agent-react-devtools@0.4.0',
    '--',
    'agent-react-devtools',
    'stop',
  ]);
  assert.equal(vi.mocked(stopReactDevtoolsCompanion).mock.calls.length, 1);
  assert.deepEqual(vi.mocked(stopReactDevtoolsCompanion).mock.calls[0]?.[0], {
    projectRoot: '/tmp/project',
    stateDir: '/tmp/agent-device-state',
    profileKey: '/tmp/remote.json',
    consumerKey: 'default',
  });
});

test('react-devtools start configures direct remote port reverse', async () => {
  const configureDirectPortReverse = vi.fn(async () => undefined);
  vi.mocked(runCmdStreaming).mockResolvedValueOnce({
    exitCode: 0,
    stdout: '',
    stderr: '',
  });

  const exitCode = await runReactDevtoolsCommand(['start'], {
    stateDir: '/tmp/agent-device-state',
    session: 'default',
    flags: {
      ...remoteBridgeScope,
      metroProxyBaseUrl: undefined,
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
      remoteConfig: '/tmp/remote.json',
      session: 'default',
    },
    configureDirectPortReverse,
  });

  assert.equal(exitCode, 0);
  assert.equal(configureDirectPortReverse.mock.calls.length, 1);
  assertNoRemoteCompanion();
});

test('react-devtools start keeps bridge-backed Android on companion tunnel', async () => {
  const env = { ...process.env };
  const configureDirectPortReverse = vi.fn(async () => undefined);
  mockRemoteCompanionSuccess();

  const exitCode = await runReactDevtoolsCommand(['start'], {
    stateDir: '/tmp/agent-device-state',
    session: 'default',
    cwd: '/tmp/project',
    env,
    flags: {
      ...remoteBridgeScope,
      leaseBackend: 'android-instance',
      remoteConfig: '/tmp/remote.json',
      session: 'default',
    },
    configureDirectPortReverse,
  });

  assert.equal(exitCode, 0);
  assert.equal(configureDirectPortReverse.mock.calls.length, 0);
  assertRemoteCompanionStarted(env);
});

test('react-devtools skips companion for non-bridge remote sessions', async () => {
  await runStatusWithoutCompanion({
    ...remoteBridgeScope,
    leaseBackend: 'ios-simulator',
  });
});

test('react-devtools skips companion when remote bridge backend is missing', async () => {
  await runStatusWithoutCompanion(remoteBridgeScope);
});

for (const { label, leaseBackend } of remoteBridgeBackends) {
  test(`react-devtools fails clearly when remote ${label} bridge scope is incomplete`, async () => {
    await assert.rejects(
      () =>
        runReactDevtoolsCommand(['status'], {
          stateDir: '/tmp/agent-device-state',
          session: 'default',
          flags: {
            leaseBackend,
            metroProxyBaseUrl: 'https://bridge.example.test',
            tenant: 'tenant-1',
            runId: 'run-1',
            leaseId: 'lease-1',
          },
        }),
      /react-devtools remote bridge requires metroBearerToken/,
    );

    assert.equal(vi.mocked(runCmdStreaming).mock.calls.length, 0);
    assertNoRemoteCompanion();
  });
}
