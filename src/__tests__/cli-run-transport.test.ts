import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, test, vi } from 'vitest';
import {
  hashRemoteConfigFile,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { runCli } from '../cli.ts';
import type { DaemonRequest, DaemonResponse } from '../daemon-client/daemon-client.ts';
import { makeTempWorkspace } from './cli-config-fixtures.ts';

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
      ['open', '--state-dir', stateDir, '--json'],
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
