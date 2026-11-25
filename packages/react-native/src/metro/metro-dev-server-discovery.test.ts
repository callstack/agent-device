import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  METRO_RELOAD_REASONS,
  canDiscoverForDeviceKind,
  discoverLocalMetroServer,
  metroDevServerUnresolvedError,
  resolveMetroReloadServerUrl,
  type LocalMetroServer,
  type MetroAppTarget,
} from './metro-dev-server-discovery.ts';

const host: HostEnvironment = { env: {}, cwd: '/app/project' };
const simulatorApp: MetroAppTarget = {
  platform: 'ios',
  deviceKind: 'simulator',
  deviceId: 'UDID-1',
  appId: 'com.example.app',
};

function serverAt(port: number, projectRoot?: string): LocalMetroServer {
  return {
    serverUrl: new URL(`http://127.0.0.1:${port}`),
    ...(projectRoot ? { projectRoot } : {}),
  };
}

function probeReturning(
  servers: LocalMetroServer[],
  recorded: { appRead: number; portsRead: number } = { appRead: 0, portsRead: 0 },
) {
  const byUrl = new Map(servers.map((server) => [server.serverUrl.origin, server]));
  return {
    record: recorded,
    probe: {
      listListeningPorts: async () => {
        recorded.portsRead += 1;
        return servers.map((server) => Number(server.serverUrl.port));
      },
      probeServer: async (url: URL) => byUrl.get(url.origin),
      readAppReportedServerUrl: async () => {
        recorded.appRead += 1;
        return undefined;
      },
    },
  };
}

test('a binding is the answer: neither the app nor the local ports are consulted', async () => {
  const probe = probeReturning([serverAt(8096, '/app/project')]);
  const explicit = await resolveMetroReloadServerUrl({
    metroPort: 9100,
    host,
    app: simulatorApp,
    probe: probe.probe,
  });
  assert.equal(explicit.resolvedBy, 'binding');
  assert.equal(explicit.serverUrl.port, '9100');

  const bound = await resolveMetroReloadServerUrl({
    runtime: { metroHost: '127.0.0.1', metroPort: 8082 },
    host,
    app: simulatorApp,
    probe: probe.probe,
  });
  assert.equal(bound.resolvedBy, 'binding');
  assert.equal(bound.serverUrl.port, '8082');
  assert.deepEqual(probe.record, { appRead: 0, portsRead: 0 });
});

test('with no binding, the address the app itself stored wins over a local search', async () => {
  const probe = probeReturning([serverAt(8096, '/app/project')]);
  const resolved = await resolveMetroReloadServerUrl({
    host,
    app: simulatorApp,
    probe: {
      ...probe.probe,
      readAppReportedServerUrl: async () => new URL('http://127.0.0.1:8096'),
    },
  });
  assert.equal(resolved.resolvedBy, 'app-reported');
  assert.equal(resolved.serverUrl.port, '8096');
  assert.equal(probe.record.portsRead, 0);
});

test('an app address with no server behind it falls through to the local search', async () => {
  const resolved = await resolveMetroReloadServerUrl({
    host,
    app: simulatorApp,
    probe: {
      listListeningPorts: async () => [8096],
      probeServer: async (url: URL) =>
        url.port === '8096' ? serverAt(8096, '/app/project') : undefined,
      readAppReportedServerUrl: async () => new URL('http://127.0.0.1:8097'),
    },
  });
  assert.equal(resolved.resolvedBy, 'local-project-root');
  assert.equal(resolved.serverUrl.port, '8096');
});

test("the local search matches the project root and never picks another project's server", async () => {
  const matching = await discoverLocalMetroServer({
    projectRoots: ['/app/project'],
    listListeningPorts: async () => [8081, 8096],
    probeServer: async (url: URL) =>
      url.port === '8096'
        ? serverAt(8096, '/app/project/packages/mobile')
        : serverAt(8081, '/other/project'),
  });
  assert.equal(matching?.serverUrl.port, '8096');

  const foreign = await discoverLocalMetroServer({
    projectRoots: ['/app/project'],
    listListeningPorts: async () => [8081],
    probeServer: async () => serverAt(8081, '/other/project'),
  });
  assert.equal(foreign, undefined);
});

test("a running server that reports no project root is not this project's dev server", async () => {
  const probe = probeReturning([serverAt(8096)]);
  await assert.rejects(
    () => resolveMetroReloadServerUrl({ host, app: simulatorApp, probe: probe.probe }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, METRO_RELOAD_REASONS.devServerUnresolved.reason);
      return true;
    },
  );
});

test('nothing found fails typed and names the address the fallback would have used', async () => {
  const probe = probeReturning([]);
  await assert.rejects(
    () => resolveMetroReloadServerUrl({ host, app: simulatorApp, probe: probe.probe }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.code, 'COMMAND_FAILED');
      assert.equal(error.details?.reason, METRO_RELOAD_REASONS.devServerUnresolved.reason);
      assert.equal(error.details?.triedUrl, 'http://localhost:8081/');
      assert.match(String(error.details?.hint), /--metro-port <port>/);
      assert.match(error.message, /http:\/\/localhost:8081/);
      return true;
    },
  );
});

test('a device this machine does not host keeps the previous address instead of probing ports', async () => {
  for (const deviceKind of ['device', undefined] as const) {
    const probe = probeReturning([serverAt(8096, '/app/project')]);
    const resolved = await resolveMetroReloadServerUrl({
      host,
      app: { ...simulatorApp, deviceKind },
      probe: probe.probe,
    });
    assert.equal(resolved.resolvedBy, 'default');
    assert.equal(resolved.serverUrl.toString(), 'http://localhost:8081/');
    assert.deepEqual(probe.record, { appRead: 0, portsRead: 0 });
  }
  assert.equal(canDiscoverForDeviceKind('device'), false);
  assert.equal(canDiscoverForDeviceKind('simulator'), true);
  assert.equal(canDiscoverForDeviceKind('emulator'), true);
});

test('the typed failure reads as its own reason', () => {
  const error = metroDevServerUnresolvedError();
  assert.equal(error.details?.reason, 'metro_dev_server_unresolved');
});
