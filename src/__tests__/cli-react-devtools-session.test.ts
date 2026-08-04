import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { mkdtempForTestSync } from './test-utils/tmp-dir.ts';

vi.mock('../cli/commands/react-devtools.ts', () => ({
  runReactDevtoolsCommand: vi.fn(async () => 0),
}));

import { runCli } from '../cli.ts';
import { runReactDevtoolsCommand } from '../cli/commands/react-devtools.ts';
import { installIsolatedCliTestEnv } from './cli-test-env.ts';
import {
  hashRemoteConfigFile,
  writeRemoteConnectionState,
} from '../remote/remote-connection-state.ts';
import type {
  DaemonRequest,
  DaemonResponse,
  sendToDaemon as SendToDaemon,
} from '../daemon/client/daemon-client.ts';

afterEach(() => {
  vi.clearAllMocks();
});

function createLimrunConnectionFixture(): { tempRoot: string; stateDir: string } {
  const tempRoot = mkdtempForTestSync('agent-device-react-devtools-limrun-');
  const stateDir = path.join(tempRoot, 'state');
  const remoteConfigPath = path.join(tempRoot, 'limrun.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({ platform: 'android' }));
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'limrun-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: {},
      tenant: 'limrun',
      runId: 'run-1',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      leaseProvider: 'limrun',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });
  return { tempRoot, stateDir };
}

test('react-devtools uses active remote connection session after defaults are merged', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-react-devtools-session-');
  const stateDir = path.join(tempRoot, 'state');
  const remoteConfigPath = path.join(tempRoot, 'remote.json');
  fs.writeFileSync(
    remoteConfigPath,
    JSON.stringify({
      daemonBaseUrl: 'https://daemon.example.test',
      platform: 'android',
      metroProxyBaseUrl: 'https://bridge.example.test',
      metroBearerToken: 'token',
    }),
  );
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'adc-android',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl: 'https://daemon.example.test', transport: 'http' },
      tenant: 'tenant-1',
      runId: 'run-1',
      leaseId: 'lease-1',
      leaseBackend: 'android-instance',
      platform: 'android',
      connectedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
  });

  const originalExit = process.exit;
  let exitCode: number | undefined;
  const restoreEnv = installIsolatedCliTestEnv();
  (process as any).exit = ((code?: number) => {
    exitCode = code ?? 0;
  }) as typeof process.exit;

  const sendToDaemon = async (): Promise<DaemonResponse> => ({ ok: true, data: {} });

  try {
    await runCli(['react-devtools', 'status', '--state-dir', stateDir], { sendToDaemon });
  } finally {
    restoreEnv();
    process.exit = originalExit;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  assert.equal(exitCode, 0);
  assert.equal(vi.mocked(runReactDevtoolsCommand).mock.calls.length, 1);
  assert.equal(vi.mocked(runReactDevtoolsCommand).mock.calls[0]?.[1]?.session, 'adc-android');
});

test('react-devtools starts Limrun port reverse through the daemon', async () => {
  const { tempRoot, stateDir } = createLimrunConnectionFixture();
  const originalExit = process.exit;
  let exitCode: number | undefined;
  const restoreEnv = installIsolatedCliTestEnv();
  (process as any).exit = ((code?: number) => {
    exitCode = code ?? 0;
  }) as typeof process.exit;
  const requests: Array<Omit<DaemonRequest, 'token'>> = [];
  const transportOptions: Array<Parameters<typeof SendToDaemon>[1]> = [];
  const sendToDaemon = async (
    request: Omit<DaemonRequest, 'token'>,
    options?: Parameters<typeof SendToDaemon>[1],
  ): Promise<DaemonResponse> => {
    requests.push(request);
    transportOptions.push(options);
    return { ok: true, data: {} };
  };
  vi.mocked(runReactDevtoolsCommand).mockImplementationOnce(async (_args, options) => {
    assert.ok(options?.configureDirectPortReverse);
    await options.configureDirectPortReverse();
    return 0;
  });

  try {
    await runCli(
      [
        'react-devtools',
        'start',
        '--state-dir',
        stateDir,
        '--daemon-auth-token',
        'synthetic-direct-token',
      ],
      { sendToDaemon },
    );
  } finally {
    restoreEnv();
    process.exit = originalExit;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  assert.equal(exitCode, 0);
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.ok(request);
  assert.equal(request.command, 'runtime');
  assert.deepEqual(request.positionals, ['port-reverse']);
  assert.equal(request.session, 'limrun-android');
  assert.equal(request.flags?.leaseProvider, 'limrun');
  assert.equal(request.flags?.devicePort, 8097);
  assert.equal(request.flags?.hostPort, 8097);
  assert.equal(request.flags?.portReverseName, 'react-devtools');
  assert.equal(Object.hasOwn(request.flags ?? {}, 'daemonAuthToken'), false);
  assert.deepEqual(transportOptions, [{ authToken: 'synthetic-direct-token' }]);
  const commandOptions = vi.mocked(runReactDevtoolsCommand).mock.calls[0]?.[1];
  assert.equal(Object.hasOwn(commandOptions?.flags ?? {}, 'daemonAuthToken'), false);
});
