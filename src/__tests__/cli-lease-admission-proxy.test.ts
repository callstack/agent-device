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

test.for<[string, string[], string | undefined]>([
  ['snapshot', ['snapshot'], LEASE_SCOPE.leaseProvider],
  // A `proxy` provider connection reallocates an install by spec, and this daemon has no device to
  // grant. The URL is a loopback port with no listener, so a download never leaves the host.
  ['install_source', ['install-from-source', 'http://127.0.0.1:1/app.apk'], undefined],
])(
  'a dropped lease is reallocated for %s through the proxy without a heartbeat',
  async ([command, argv, leaseProvider], t) => {
    if (await skipWhenLoopbackUnavailable(t)) return;
    await withProxiedDaemon(async ({ baseUrl, project, stateDir, upstream, cli }) => {
      const client = createAgentDeviceClient({
        daemonBaseUrl: baseUrl,
        daemonAuthToken: 'client-secret',
        daemonTransport: 'http',
      });
      const scope = { ...LEASE_SCOPE, leaseProvider };
      const lease = await client.leases.allocate({ ...scope, leaseId: 'b'.repeat(32) });
      writeConnection(stateDir, project, baseUrl, lease.leaseId, leaseProvider);
      await client.leases.release({ ...scope, leaseId: lease.leaseId });
      upstream.length = 0;

      const result = await cli(argv);

      const reallocated = readRemoteConnectionState({ stateDir, session: 'agent' })?.leaseId;
      assert.ok(reallocated && reallocated !== lease.leaseId, result.stdout);
      // The setup above already cached `/health` for this endpoint in this process, so only RPCs show.
      assert.deepEqual(
        upstream.filter((route) => route.startsWith('/rpc')),
        [`/rpc ${command}`, '/rpc agent_device.lease.allocate', `/rpc ${command}`],
      );
      // The resent command passed admission: whatever it answered, it was not the lease refusal.
      if (result.code !== null) {
        assert.notEqual(JSON.parse(result.stdout).error.details?.reason, 'LEASE_NOT_FOUND');
      }
    });
  },
);

// A reused lease on the connection does not move a command that checks no lease off the checked route.
test('a checked connection sends a command that checks no lease as its one checked request', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  await withProxiedDaemon(async ({ baseUrl, project, stateDir, upstream, cli }) => {
    const remoteConfigPath = path.join(project, 'checked.remote.json');
    fs.writeFileSync(
      remoteConfigPath,
      JSON.stringify({
        daemonBaseUrl: baseUrl,
        daemonRpc: 'checked',
        tenant: LEASE_SCOPE.tenant,
        runId: LEASE_SCOPE.runId,
        leaseProvider: LEASE_SCOPE.leaseProvider,
        clientId: LEASE_SCOPE.clientId,
        leaseBackend: LEASE_SCOPE.leaseBackend,
        platform: 'android',
      }),
    );
    const connected = await cli(['connect', '--remote-config', remoteConfigPath]);
    assert.equal(connected.code, null, connected.stdout);
    const state = readRemoteConnectionState({ stateDir, session: 'agent' });
    assert.ok(state?.daemon?.checkedRpcTarget, connected.stdout);
    writeRemoteConnectionState({
      stateDir,
      state: { ...state, leaseId: 'c'.repeat(32), deviceKey: LEASE_SCOPE.deviceKey },
    });

    upstream.length = 0;
    const listed = await cli(['session', 'list']);
    assert.equal(listed.code, null, listed.stdout);
    assert.deepEqual(upstream, ['/rpc/checked session_list']);
  });
});

type ProxiedDaemon = Readonly<{
  /** The proxy's base URL, which the CLI and the SDK client reach with `client-secret`. */
  baseUrl: string;
  project: string;
  stateDir: string;
  /** What the proxy forwarded to the daemon: the path, and for an RPC its method or command. */
  upstream: string[];
  cli: (argv: string[]) => ReturnType<typeof runCliCapture>;
}>;

/** Runs `run` against a real daemon behind a real proxy, with an empty CLI workspace. */
async function withProxiedDaemon(run: (proxied: ProxiedDaemon) => Promise<void>) {
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
    const stateDir = path.join(root, 'state');
    const cli = async (argv: string[]) =>
      await runCliCapture([...argv, '--session', 'agent', '--state-dir', stateDir, '--json'], {
        cwd: project,
        env: { HOME: home, AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'client-secret' },
        useRealDaemonClient: true,
      });
    await run({ baseUrl, project, stateDir, upstream, cli });
  } finally {
    await closeLoopbackServer(proxy);
    await daemon.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

async function describe(request: Request): Promise<string> {
  const route = new URL(request.url).pathname;
  if (route !== '/rpc' && route !== '/rpc/checked') return route;
  const body = JSON.parse(await request.clone().text()) as {
    method?: string;
    params?: { command?: string };
  };
  return `${route} ${body.method === 'agent_device.command' ? body.params?.command : body.method}`;
}

function writeConnection(
  stateDir: string,
  project: string,
  baseUrl: string,
  leaseId: string,
  leaseProvider: string | undefined,
) {
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
      leaseProvider,
      clientId: LEASE_SCOPE.clientId,
      deviceKey: LEASE_SCOPE.deviceKey,
      platform: 'android',
      connectedAt: now,
      updatedAt: now,
    },
  });
}
