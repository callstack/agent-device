import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { createTestHostEnvironment, mkdtempForTestSync } from '@agent-device/test-kit';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';

const mocks = vi.hoisted(() => ({ ensureManagedDaemon: vi.fn() }));

vi.mock('../daemon-client-lifecycle.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../daemon-client-lifecycle.ts')>()),
  ensureManagedDaemon: mocks.ensureManagedDaemon,
}));

import { ensureProxyUpstreamDaemon } from '../daemon-client-proxy-upstream.ts';

test('the proxy upstream is the managed local HTTP daemon of the resolved state dir', async () => {
  const stateDir = mkdtempForTestSync('agent-device-proxy-upstream-');
  mocks.ensureManagedDaemon.mockResolvedValue({
    info: { httpPort: 54321, token: 'daemon-secret', pid: 4242 },
    startedByClient: false,
  });

  const upstream = await ensureProxyUpstreamDaemon({
    stateDir,
    host: createTestHostEnvironment({
      env: { AGENT_DEVICE_DAEMON_BASE_URL: 'http://127.0.0.1:1' },
    }),
  });

  assert.deepEqual(upstream, {
    httpPort: 54321,
    token: 'daemon-secret',
    stateDir: resolveDaemonPaths(stateDir).baseDir,
  });
  const settings = mocks.ensureManagedDaemon.mock.calls[0]![0];
  expect(settings).toMatchObject({
    daemonLifecycle: 'managed',
    transportPreference: 'http',
    serverMode: 'http',
  });
  assert.equal(settings.remoteBaseUrl, undefined);
});
