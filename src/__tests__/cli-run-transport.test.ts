import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  hashRemoteConfigFile,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { runCli } from '../cli.ts';
import type { DaemonRequest, DaemonResponse } from '@agent-device/daemon-client';
import { makeTempWorkspace } from '@agent-device/test-kit';
import type { RemoteConnectionState } from '@agent-device/remote/remote-connection-state';

type RemoteConnectionDaemon = NonNullable<RemoteConnectionState['daemon']>;

afterEach(() => {
  vi.restoreAllMocks();
});

class ProcessExit extends Error {}

test('a CLI run builds one transport, shared by the remote-materialization client and the command client', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'remote.json');
  fs.writeFileSync(remoteConfig, JSON.stringify({}), 'utf8');
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'transport-run',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      tenant: 'tenant',
      runId: 'run-transport',
      leaseBackend: 'ios-instance',
      leaseProvider: 'limrun',
      platform: 'ios',
      connectedAt: now,
      updatedAt: now,
    },
  });
  const commands: string[] = [];
  const transportForHost = vi.fn(() => async (req: Omit<DaemonRequest, 'token'>) => {
    commands.push(req.command);
    return (
      req.command === 'lease_allocate'
        ? {
            ok: true,
            data: {
              lease: {
                leaseId: 'lease-transport',
                tenantId: 'tenant',
                runId: 'run-transport',
                backend: 'ios-instance',
              },
            },
          }
        : { ok: true, data: {} }
    ) satisfies DaemonResponse;
  });
  const host = { env: { HOME: home, PATH: process.env.PATH }, cwd: project };
  const exitCodes: Array<number | undefined> = [];
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    exitCodes.push(code);
    throw new ProcessExit();
  }) as never);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);

  try {
    // A successful run returns without exiting; a failure that exits or throws fails the test.
    await runCli(
      ['open', '--session', 'transport-run', '--state-dir', stateDir, '--json'],
      { sendToDaemon: vi.fn(), transportForHost },
      host,
    ).catch((error: unknown) => {
      if (!(error instanceof ProcessExit)) throw error;
    });

    assert.deepEqual(exitCodes, [], 'the run completed without exiting');
    assert.ok(commands.includes('lease_allocate'), `materialization ran: ${commands.join(',')}`);
    assert.ok(commands.length > 1, 'the command client sent through the same transport');
    assert.equal(transportForHost.mock.calls.length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('checked RPC holds only for the base URL connect validated; another endpoint goes health-first', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'remote.json');
  fs.writeFileSync(remoteConfig, JSON.stringify({ daemonRpc: 'checked' }), 'utf8');
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'checked-endpoint',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      daemon: {
        baseUrl: 'http://127.0.0.1:7001',
        transport: 'http',
        checkedRpcBaseUrl: 'http://127.0.0.1:7001',
      },
      tenant: 'tenant',
      runId: 'run-checked',
      connectedAt: now,
      updatedAt: now,
    },
  });
  const sent: Array<{ daemonBaseUrl?: string; daemonRpc?: string }> = [];
  const transportForHost = vi.fn(() => async (req: Omit<DaemonRequest, 'token'>) => {
    sent.push({ daemonBaseUrl: req.flags?.daemonBaseUrl, daemonRpc: req.flags?.daemonRpc });
    return { ok: true, data: { sessions: [] } } satisfies DaemonResponse;
  });
  const host = { env: { HOME: home, PATH: process.env.PATH }, cwd: project };
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new ProcessExit();
  }) as never);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  const run = async (extra: string[]) =>
    await runCli(
      [
        'session',
        'list',
        '--session',
        'checked-endpoint',
        '--state-dir',
        stateDir,
        '--json',
        ...extra,
      ],
      { sendToDaemon: vi.fn(), transportForHost },
      host,
    );

  await run([]);
  await run(['--daemon-base-url', 'http://127.0.0.1:7002']);
  // The same endpoint, spelled with a trailing slash, is still the validated one.
  await run(['--daemon-base-url', 'http://127.0.0.1:7001/']);

  assert.deepEqual(sent, [
    { daemonBaseUrl: 'http://127.0.0.1:7001', daemonRpc: 'checked' },
    { daemonBaseUrl: 'http://127.0.0.1:7002', daemonRpc: undefined },
    { daemonBaseUrl: 'http://127.0.0.1:7001/', daemonRpc: 'checked' },
  ]);
});

test('a connection that recorded checked RPC without a probed endpoint never applies it to a later URL', async () => {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  const remoteConfig = path.join(project, 'remote.json');
  fs.writeFileSync(remoteConfig, JSON.stringify({ daemonRpc: 'checked' }), 'utf8');
  const now = new Date().toISOString();
  // A direct-provider connection carries checked mode, but no daemon URL was probed or recorded.
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'checked-provider',
      remoteConfigPath: remoteConfig,
      remoteConfigHash: hashRemoteConfigFile(remoteConfig),
      daemon: { transport: 'http', rpc: 'checked' } as RemoteConnectionDaemon,
      tenant: 'tenant',
      runId: 'run-provider',
      connectedAt: now,
      updatedAt: now,
    },
  });
  const sent: Array<{ daemonRpc?: string }> = [];
  const transportForHost = vi.fn(() => async (req: Omit<DaemonRequest, 'token'>) => {
    sent.push({ daemonRpc: req.flags?.daemonRpc });
    return { ok: true, data: { sessions: [] } } satisfies DaemonResponse;
  });
  // The endpoint arrives later, through the environment.
  const host = {
    env: {
      HOME: home,
      PATH: process.env.PATH,
      AGENT_DEVICE_DAEMON_BASE_URL: 'http://127.0.0.1:7003',
    },
    cwd: project,
  };
  vi.spyOn(process, 'exit').mockImplementation((() => {
    throw new ProcessExit();
  }) as never);
  vi.spyOn(process.stdout, 'write').mockReturnValue(true);
  vi.spyOn(process.stderr, 'write').mockReturnValue(true);

  await runCli(
    ['session', 'list', '--session', 'checked-provider', '--state-dir', stateDir, '--json'],
    { sendToDaemon: vi.fn(), transportForHost },
    host,
  );

  assert.deepEqual(sent, [{ daemonRpc: undefined }]);
});
