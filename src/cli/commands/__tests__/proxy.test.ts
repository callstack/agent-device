// #3420: the proxy command's startup path — daemon-backed upstream resolution, client-token
// sourcing, and real loopback binding — is pinned through the command handler itself. The
// process-spawn seam (`ensureDaemon`) and the output sink are mocked at the module boundary the
// command consumes; the proxy server and its listen are the real ones.
import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, test, vi } from 'vitest';
import {
  skipWhenLoopbackUnavailable,
  closeLoopbackServer,
  listenOnLoopback,
} from '@agent-device/test-kit/loopback';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

const mocks = vi.hoisted(() => ({
  ensureDaemon: vi.fn(),
  writeCommandOutput: vi.fn(async (..._args: unknown[]) => undefined),
  createdServers: [] as http.Server[],
  listenArgs: [] as { port: number; host: string }[],
}));

vi.mock('../../../daemon-client/daemon-client-lifecycle.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../daemon-client/daemon-client-lifecycle.ts')>()),
  ensureDaemon: mocks.ensureDaemon,
}));
vi.mock('@agent-device/proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/proxy')>();
  return {
    ...actual,
    createDaemonProxyServer: (options: Parameters<typeof actual.createDaemonProxyServer>[0]) => {
      const server = actual.createDaemonProxyServer(options);
      // Record what the command asks the real server to bind; the bind itself stays real.
      const listen = server.listen.bind(server);
      server.listen = ((port?: number, host?: string, callback?: () => void) => {
        mocks.listenArgs.push({ port: port ?? 0, host: String(host) });
        return listen(port, host, callback);
      }) as typeof server.listen;
      mocks.createdServers.push(server);
      return server;
    },
  };
});
vi.mock('../shared.ts', () => ({ writeCommandOutput: mocks.writeCommandOutput }));

import { proxyCommand, renderProxyStartup } from '../proxy.ts';
import type { AgentDeviceClient } from '../../../agent-device-client.ts';

// The proxy command never reads the client; a typed stub that throws on any access proves it
// without the `{} as never` blind cast.
const unreferencedClient = new Proxy({} as AgentDeviceClient, {
  get: () => {
    throw new Error('proxy must not touch the client');
  },
});

afterEach(async () => {
  vi.clearAllMocks();
  mocks.listenArgs.splice(0, mocks.listenArgs.length);
  const servers = mocks.createdServers.splice(0, mocks.createdServers.length);
  for (const server of servers) {
    await closeLoopbackServer(server);
  }
});

function runProxy(flags: Partial<Parameters<typeof proxyCommand>[0]['flags']> = {}) {
  // The command streams its startup card and then serves until interrupted, so the handler
  // promise intentionally never settles; the test observes the emitted output and lets it float.
  void proxyCommand({
    positionals: [],
    flags: { json: true, help: false, version: false, ...flags },
    client: unreferencedClient,
  });
}

async function waitForStartupOutput(): Promise<{
  data: Record<string, unknown>;
  render: () => string;
}> {
  await vi.waitFor(() => {
    assert.equal(mocks.writeCommandOutput.mock.calls.length, 1);
  });
  const call = mocks.writeCommandOutput.mock.calls[0]!;
  return {
    data: call[1] as Record<string, unknown>,
    render: call[2] as () => string,
  };
}

test('proxy rejects positional arguments', async () => {
  await assert.rejects(
    proxyCommand({
      positionals: ['extra'],
      flags: { json: true, help: false, version: false },
      client: unreferencedClient,
    }),
    (error: { code?: string }) => error.code === 'INVALID_ARGS',
  );
  assert.equal(mocks.ensureDaemon.mock.calls.length, 0);
});

test('proxy refuses to start when the local daemon has no HTTP endpoint', async () => {
  mocks.ensureDaemon.mockResolvedValue({
    info: { token: 'daemon-secret', pid: 4242 },
    startedByClient: false,
  });

  await assert.rejects(
    proxyCommand({
      positionals: [],
      flags: { json: true, help: false, version: false },
      client: unreferencedClient,
    }),
    (error: { code?: string; details?: { hint?: string } }) =>
      error.code === 'COMMAND_FAILED' && /fresh --state-dir/.test(String(error.details?.hint)),
  );
  assert.equal(mocks.writeCommandOutput.mock.calls.length, 0);
});

test('proxy binds a loopback listener and reports the supplied client token', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  const stateDir = mkdtempForTestSync('agent-device-proxy-start-');
  mocks.ensureDaemon.mockResolvedValue({
    info: { httpPort: 54321, token: 'daemon-secret', pid: 4242 },
    startedByClient: false,
  });

  runProxy({
    stateDir,
    // The trimmed flag value becomes the client token instead of a generated one.
    daemonAuthToken: '  proxy-token  ',
  });
  const { data, render } = await waitForStartupOutput();

  assert.deepEqual(mocks.listenArgs, [{ port: 0, host: '127.0.0.1' }]);
  assert.equal(data.upstreamBaseUrl, 'http://127.0.0.1:54321');
  assert.equal(data.token, 'proxy-token');
  assert.equal(data.stateDir, resolveDaemonPaths(stateDir).baseDir);
  const proxyBaseUrl = String(data.proxyBaseUrl);
  assert.match(proxyBaseUrl, /^http:\/\/(127\.0\.0\.1|\[::1\]):\d+$/);
  assert.equal(data.agentDeviceBaseUrl, `${proxyBaseUrl}/agent-device`);
  const startupCard = render();
  // The human render is the exported startup-card renderer applied to the emitted payload.
  assert.equal(
    startupCard,
    renderProxyStartup(data as unknown as Parameters<typeof renderProxyStartup>[0]),
  );
  assert.match(startupCard, /Proxy listening at/);
  assert.ok(startupCard.includes(proxyBaseUrl));
  // The daemon the proxy fronts is the local one of the resolved state dir, never a remote URL.
  const settings = mocks.ensureDaemon.mock.calls[0]![0];
  assert.equal(settings.paths.baseDir, resolveDaemonPaths(stateDir).baseDir);
  assert.equal(settings.remoteBaseUrl, undefined);
});

test('proxy honors proxy host and port flags and mints a token when none is supplied', async (t) => {
  if (await skipWhenLoopbackUnavailable(t)) return;
  mocks.ensureDaemon.mockResolvedValue({
    info: { httpPort: 54322, token: 'daemon-secret', pid: 4242 },
    startedByClient: false,
  });
  // Reserve a real port through an ephemeral bind so the flag value is distinguishable
  // from the `0` default the command would otherwise pass to listen.
  const sentinel = http.createServer();
  const reservedPort = await listenOnLoopback(sentinel);
  await closeLoopbackServer(sentinel);

  runProxy({ proxyHost: ' localhost ', proxyPort: reservedPort });
  const { data } = await waitForStartupOutput();

  assert.deepEqual(mocks.listenArgs, [{ port: reservedPort, host: 'localhost' }]);
  // The reported URL carries the bound address, which names the reserved port either way.
  assert.match(String(data.proxyBaseUrl), /^http:\/\/(localhost|127\.0\.0\.1|\[::1\]):\d+$/);
  assert.ok(String(data.proxyBaseUrl).endsWith(`:${reservedPort}`));
  assert.match(String(data.token), /^[0-9a-f]{64}$/);
});
