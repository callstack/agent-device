import { test } from 'vitest';
import assert from 'node:assert/strict';
import { AppError } from '@agent-device/kernel/errors';
import type { HostEnvironment } from '@agent-device/kernel/source-value';
import {
  METRO_RELOAD_REASONS,
  canDiscoverForApp,
  discoverLocalMetroServer,
  metroDevServerUnresolvedError,
  resolveMetroReloadServerUrl,
  type LocalMetroServer,
  type MetroAppTarget,
  type MetroDevServerProbe,
} from './metro-dev-server-discovery.ts';

const host: HostEnvironment = { env: {}, cwd: '/app/project' };
// The trait `open` records when it resolved the device from this machine's own inventory.
const simulatorApp: MetroAppTarget = {
  platform: 'ios',
  deviceKind: 'simulator',
  deviceId: 'UDID-1',
  appId: 'com.example.app',
  hostedLocally: true,
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
    } satisfies MetroDevServerProbe,
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

test('a blank port is no binding: an empty --metro-port reaches discovery, not the default', async () => {
  const probe = probeReturning([serverAt(8096, '/app/project')]);
  const resolved = await resolveMetroReloadServerUrl({
    metroPort: '',
    host,
    app: simulatorApp,
    probe: probe.probe,
  });
  assert.equal(resolved.resolvedBy, 'local-project-root');
  assert.equal(resolved.serverUrl.port, '8096');

  // A session hint that carries no host name is no binding either.
  const sessionHost = await resolveMetroReloadServerUrl({
    runtime: { metroHost: '  ' },
    host,
    app: simulatorApp,
    probe: probe.probe,
  });
  assert.equal(sessionHost.resolvedBy, 'local-project-root');
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

test('an app-reported server for another project is refused, not reloaded', async () => {
  // The app's stored port now holds a different project's Metro: neither the app-reported step nor the
  // local sweep may accept it, so reload refuses rather than restarting an unrelated app.
  const probe = probeReturning([serverAt(8096, '/other/project')]);
  await assert.rejects(
    () =>
      resolveMetroReloadServerUrl({
        host,
        app: simulatorApp,
        projectRoot: '/app/project',
        probe: {
          ...probe.probe,
          readAppReportedServerUrl: async () => new URL('http://127.0.0.1:8096'),
        },
      }),
    (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.reason, METRO_RELOAD_REASONS.devServerUnresolved.reason);
      return true;
    },
  );
});

test('a server that runs and reports no project root is still the address the app named', async () => {
  const probe = probeReturning([serverAt(8096)]);
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
});

test('an app-reported address that is not loopback is taken without probing this host', async () => {
  const probe = probeReturning([]);
  const resolved = await resolveMetroReloadServerUrl({
    host,
    app: simulatorApp,
    probe: {
      ...probe.probe,
      readAppReportedServerUrl: async () => new URL('http://10.0.0.5:19000'),
    },
  });
  assert.equal(resolved.resolvedBy, 'app-reported');
  assert.equal(resolved.serverUrl.origin, 'http://10.0.0.5:19000');
});

test('an app-reported address whose probe fails is refused instead of trusted', async () => {
  const resolved = await resolveMetroReloadServerUrl({
    host,
    app: simulatorApp,
    probe: {
      listListeningPorts: async () => [8096, 8097],
      probeServer: async (url: URL) => {
        if (url.port === '8097') throw new Error('ECONNREFUSED');
        return serverAt(8096, '/app/project');
      },
      readAppReportedServerUrl: async () => new URL('http://127.0.0.1:8097'),
    },
  });
  assert.equal(resolved.resolvedBy, 'local-project-root');
  assert.equal(resolved.serverUrl.port, '8096');
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

test('a port lister that fails, or finds nothing, yields no server', async () => {
  const failing = await discoverLocalMetroServer({
    projectRoots: ['/app/project'],
    listListeningPorts: async () => {
      throw new Error('lsof not found in PATH');
    },
    probeServer: async () => serverAt(8081, '/app/project'),
  });
  assert.equal(failing, undefined);

  const empty = await discoverLocalMetroServer({
    projectRoots: ['/app/project'],
    listListeningPorts: async () => [],
    probeServer: async () => serverAt(8081, '/app/project'),
  });
  assert.equal(empty, undefined);
});

test('every listening port is probed, in bounded batches rather than at once', async () => {
  const ports = Array.from({ length: 100 }, (_, index) => 20_000 + index);
  let inFlight = 0;
  let peakInFlight = 0;
  const matching = await discoverLocalMetroServer({
    projectRoots: ['/app/project'],
    listListeningPorts: async () => ports,
    probeServer: async (url: URL) => {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return Number(url.port) === ports[ports.length - 1]
        ? serverAt(ports[ports.length - 1]!, '/app/project')
        : undefined;
    },
  });
  // The 100th port is a real candidate: truncating at the concurrency limit would miss it.
  assert.equal(matching?.serverUrl.port, String(ports[ports.length - 1]));
  assert.ok(peakInFlight <= 32, `peak in-flight was ${peakInFlight}`);
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

test('an app whose host is not proven local keeps the previous address instead of probing', async () => {
  // A provider-hosted device, a device inherited from an earlier request that reported nothing, and
  // an app-less session all leave the trait unproven.
  for (const app of [
    { ...simulatorApp, hostedLocally: false },
    { ...simulatorApp, hostedLocally: undefined },
    undefined,
  ]) {
    const probe = probeReturning([serverAt(8096, '/app/project')]);
    const resolved = await resolveMetroReloadServerUrl({ host, app, probe: probe.probe });
    assert.equal(resolved.resolvedBy, 'default');
    assert.equal(resolved.serverUrl.toString(), 'http://localhost:8081/');
    assert.deepEqual(probe.record, { appRead: 0, portsRead: 0 });
  }
});

test('discovery is allowed only for an app open proved to sit on this machine', () => {
  assert.equal(canDiscoverForApp(simulatorApp), true);
  assert.equal(canDiscoverForApp({ ...simulatorApp, deviceKind: 'emulator' }), true);
  assert.equal(canDiscoverForApp({ ...simulatorApp, deviceKind: 'device' }), true);
  assert.equal(canDiscoverForApp({ ...simulatorApp, hostedLocally: false }), false);
  assert.equal(canDiscoverForApp({ ...simulatorApp, hostedLocally: undefined }), false);
  assert.equal(canDiscoverForApp(undefined), false);
});

test('the typed failure reads as its own reason', () => {
  const error = metroDevServerUnresolvedError();
  assert.equal(error.details?.reason, 'metro_dev_server_unresolved');
});
