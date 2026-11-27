import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { createDaemonProxyServer } from '@agent-device/proxy';
import {
  closeLoopbackServer,
  listenOnLoopback,
  makeTempWorkspace,
  skipWhenLoopbackUnavailable,
} from '@agent-device/test-kit';
import { createAgentDeviceClient } from '@agent-device/client';
import {
  hashRemoteConfigFile,
  readRemoteConnectionState,
  writeRemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { runCliCapture } from './cli-capture.ts';
import { startPublicDaemonRuntime } from './test-utils/public-daemon-runtime.ts';

// The real CLI, daemon-client, proxy and daemon: a command on a lease the daemon no longer holds is
// refused at admission, the refusal crosses the proxy intact, and the CLI reallocates and resends
// once. No heartbeat runs on either attempt.

const LEASE_SCOPE = {
  tenant: 'proxy',
  runId: 'run-admission',
  leaseBackend: 'android-instance',
  leaseProvider: 'proxy',
  clientId: 'client-admission',
  // No device answers to this serial, and the daemon may list no other.
  deviceKey: 'android:mobile:emulator-9999',
} as const;

test('a lease the daemon dropped is reallocated through the proxy without a heartbeat', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const { root, home, project } = makeTempWorkspace();
  const daemon = await startPublicDaemonRuntime({
    serverMode: 'http',
    env: { AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST: 'emulator-9999' },
  });
  const upstream: string[] = [];
  const proxy = createDaemonProxyServer({
    upstreamBaseUrl: daemon.baseUrl,
    upstreamToken: daemon.runtime.token,
    clientToken: 'client-secret',
    upstreamFetch: async (request) => {
      upstream.push(await describe(request));
      return await fetch(request);
    },
  });
  try {
    const baseUrl = `http://127.0.0.1:${await listenOnLoopback(proxy)}/agent-device`;
    const client = createAgentDeviceClient({
      daemonBaseUrl: baseUrl,
      daemonAuthToken: 'client-secret',
      daemonTransport: 'http',
    });
    const lease = await client.leases.allocate({ ...LEASE_SCOPE, leaseId: 'b'.repeat(32) });
    const stateDir = path.join(root, 'state');
    writeConnection(stateDir, project, baseUrl, lease.leaseId);
    await client.leases.release({ ...LEASE_SCOPE, leaseId: lease.leaseId });
    upstream.length = 0;

    const result = await runCliCapture(
      ['snapshot', '--session', 'agent', '--state-dir', stateDir, '--json'],
      {
        cwd: project,
        env: { HOME: home, AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'client-secret' },
        useRealDaemonClient: true,
      },
    );

    const reallocated = readRemoteConnectionState({ stateDir, session: 'agent' })?.leaseId;
    assert.ok(reallocated && reallocated !== lease.leaseId, result.stdout);
    // The setup above already cached `/health` for this endpoint in this process, so only RPCs show.
    assert.deepEqual(
      upstream.filter((route) => route.startsWith('/rpc')),
      ['/rpc snapshot', '/rpc agent_device.lease.allocate', '/rpc snapshot'],
    );
    // The resent command passed admission: whatever it answered, it was not the lease refusal.
    if (result.code !== null) {
      assert.notEqual(JSON.parse(result.stdout).error.details?.reason, 'LEASE_NOT_FOUND');
    }
  } finally {
    await closeLoopbackServer(proxy);
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

async function describe(request: Request): Promise<string> {
  const route = new URL(request.url).pathname;
  if (route !== '/rpc') return route;
  const body = JSON.parse(await request.clone().text()) as {
    method?: string;
    params?: { command?: string };
  };
  return `/rpc ${body.method === 'agent_device.command' ? body.params?.command : body.method}`;
}

function writeConnection(stateDir: string, project: string, baseUrl: string, leaseId: string) {
  const remoteConfigPath = path.join(project, 'agent.remote.json');
  fs.writeFileSync(remoteConfigPath, JSON.stringify({}));
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir,
    state: {
      version: 1,
      session: 'agent',
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      daemon: { baseUrl, transport: 'http' },
      tenant: LEASE_SCOPE.tenant,
      runId: LEASE_SCOPE.runId,
      leaseId,
      leaseBackend: LEASE_SCOPE.leaseBackend,
      leaseProvider: LEASE_SCOPE.leaseProvider,
      clientId: LEASE_SCOPE.clientId,
      deviceKey: LEASE_SCOPE.deviceKey,
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    },
  });
}
