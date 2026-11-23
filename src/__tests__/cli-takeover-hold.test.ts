import { test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import type { DaemonResponse } from '@agent-device/daemon-client';
import {
  hashRemoteConfigFile,
  writeRemoteConnectionState,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { runCliCapture, type CapturedDaemonRequest } from './cli-capture.ts';

// The hold takes backend, provider and device identity from the admitted lease only, so the saved
// connection's leaseBackend and platform must reach the daemon without the hold refusing them.
test('takeover hold sends put through a saved connection that names backend and platform', async () => {
  const workspace = makeTakeoverWorkspace();
  const result = await runAgentCommand(workspace, [
    'takeover',
    'hold',
    '--session',
    's',
    '--reason',
    'handing to QA',
    '--ttl-ms',
    '60000',
  ]);
  assert.equal(result.code, null, result.stdout);
  const put = result.calls.find((call) => call.command === 'human_control');
  assert.ok(put, result.calls.map((call) => call.command).join(','));
  assert.deepEqual(put.positionals?.[0], 'put');
  assert.match(String(put.positionals?.[1]), /^takeover-/);
  const input = JSON.parse(String(put.positionals?.[2] ?? '{}')) as Record<string, unknown>;
  assert.equal(input.reason, 'handing to QA');
  assert.equal(input.ttlMs, 60_000);
});

function makeTakeoverWorkspace(): {
  root: string;
  home: string;
  project: string;
  stateDir: string;
} {
  const { root, home, project } = makeTempWorkspace();
  const stateDir = path.join(root, 'state');
  writeStoredConnection(
    { root, home, project, stateDir },
    {
      session: 's',
      tenant: 'tenant-a',
      runId: 'run-a',
      leaseBackend: 'android-instance',
      platform: 'android',
    },
  );
  return { root, home, project, stateDir };
}

function writeStoredConnection(
  workspace: { root: string; home: string; project: string; stateDir: string },
  state: Pick<RemoteConnectionState, 'session' | 'tenant' | 'runId'> &
    Partial<RemoteConnectionState>,
): void {
  const remoteConfigPath = path.join(workspace.project, `${state.session}.remote.json`);
  fs.writeFileSync(remoteConfigPath, JSON.stringify({}));
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir: workspace.stateDir,
    state: {
      version: 1,
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      connectedAt: now,
      updatedAt: now,
      ...state,
    },
  });
}

function takeoverGateway(req: CapturedDaemonRequest): Promise<DaemonResponse> {
  if (req.command === 'lease_allocate' || req.command === 'lease_heartbeat') {
    return Promise.resolve({
      ok: true,
      data: {
        lease: {
          leaseId: String(req.meta?.leaseId ?? 'lease-1'),
          tenantId: 'tenant-a',
          runId: 'run-a',
          backend: 'android-instance',
          leaseProvider: 'proxy',
          clientId: 'client-1',
          deviceKey: 'android:mobile:emulator-5554',
        },
      },
    });
  }
  if (req.command === 'human_control') {
    const holdId = String(req.positionals?.[1] ?? 'hold-1');
    return Promise.resolve({
      ok: true,
      data: {
        hold: {
          id: holdId,
          scope: { backend: 'android-instance', deviceKey: 'android:mobile:emulator-5554' },
          state: 'active',
          reason: 'handing to QA',
          createdAt: 1,
          updatedAt: 1,
          expiresAt: 61_000,
        },
        state: 'active',
      },
    });
  }
  throw new Error(`unexpected daemon command: ${req.command}`);
}

function runAgentCommand(
  workspace: { root: string; home: string; project: string; stateDir: string },
  argv: string[],
) {
  return runCliCapture([...argv, '--state-dir', workspace.stateDir, '--json'], {
    cwd: workspace.project,
    env: { HOME: workspace.home },
    sendToDaemon: takeoverGateway,
  });
}
