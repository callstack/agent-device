import { describe, expect, test } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import path from 'node:path';
import { createAgentDeviceClient } from './agent-device-client.ts';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  readMetroSessionFixture,
  closeLoopbackServer,
  mkdtempForTestSync,
  writeFakeMetroNpx,
  findFreeMetroPort,
  stopTestMetroProcess,
  listenOnLoopback,
  skipWhenLoopbackUnavailable,
  writeMetroSessionFixture,
} from '@agent-device/test-kit';

const TEST_TOKEN = 'agent-device-proxy-test-token';

test('client prepare retains local control and valid proxy runtimes when one device URL is malformed', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-metro');
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');
  const runtimeFilePath = path.join(projectRoot, '.agent-device', 'metro-runtime.json');
  const metroPort = await findFreeMetroPort();
  const proxyPort = await findFreeMetroPort();
  const requests: string[] = [];
  const proxySockets = new Set<Socket>();

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-runtime-test',
      private: true,
      dependencies: {
        'react-native': '0.0.0-test',
      },
    }),
  );
  writeFakeMetroNpx(binDir);

  const proxyServer = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${TEST_TOKEN}`) {
      res.statusCode = 401;
      res.end(JSON.stringify({ ok: false, error: 'unauthorized' }));
      return;
    }

    requests.push(req.url || '');
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      tenantId?: string;
      runId?: string;
      leaseId?: string;
      ios_runtime?: { metro_bundle_url?: string };
    };
    assert.equal(body.tenantId, 'tenant-1');
    assert.equal(body.runId, 'run-1');
    assert.equal(body.leaseId, 'lease-1');
    assert.equal(body.ios_runtime, undefined);

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/metro/bridge') {
      res.end(
        JSON.stringify({
          ok: true,
          data: {
            enabled: true,
            base_url: 'http://127.0.0.1:8081',
            status_url: 'http://127.0.0.1:8081/status',
            bundle_url: 'http://127.0.0.1:8081/index.bundle?platform=ios&dev=true&minify=false',
            ios_runtime: {
              metro_host: 'runtime-1.metro.agent-device.dev',
              metro_port: 443,
              metro_bundle_url:
                'https://runtime-1.metro.agent-device.dev/index.bundle?platform=ios&dev=true&minify=false',
            },
            android_runtime: {
              metro_host: 'bridge.example.test',
              metro_port: 443,
              metro_bundle_url: 'http://[broken',
            },
            upstream: {
              bundle_url: `http://127.0.0.1:${metroPort}/index.bundle?platform=ios&dev=true&minify=false`,
              host: '127.0.0.1',
              port: metroPort,
              status_url: `http://127.0.0.1:${metroPort}/status`,
            },
            probe: {
              reachable: true,
              status_code: 200,
              latency_ms: 3,
              detail: 'ok',
            },
          },
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ ok: false, error: 'not found' }));
  });
  proxyServer.on('connection', (socket) => {
    proxySockets.add(socket);
    socket.on('close', () => proxySockets.delete(socket));
  });
  proxyServer.listen(proxyPort, '127.0.0.1');
  proxyServer.unref();
  await once(proxyServer, 'listening');

  let pid = 0;
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;
  const client = createAgentDeviceClient({ stateDir: tempRoot, session: 'bridge' });

  try {
    const result = await client.metro.prepare({
      projectRoot,
      publicBaseUrl: `http://127.0.0.1:${metroPort}`,
      proxyBaseUrl: `http://127.0.0.1:${proxyPort}`,
      bearerToken: TEST_TOKEN,
      bridgeScope: {
        tenantId: 'tenant-1',
        runId: 'run-1',
        leaseId: 'lease-1',
      },
      port: metroPort,
      reuseExisting: false,
      installDependenciesIfNeeded: false,
      runtimeFilePath,
    });

    pid = result.pid;
    assert.equal(result.kind, 'react-native');
    assert.equal(result.started, true);
    assert.equal(result.reused, false);
    assert.equal(result.bridge?.enabled, true);
    assert.equal(result.iosRuntime.metroHost, 'runtime-1.metro.agent-device.dev');
    assert.equal(result.iosRuntime.metroPort, 443);
    assert.equal(result.iosRuntime.platform, 'ios');
    assert.equal(result.androidRuntime.metroHost, 'bridge.example.test');
    assert.equal(result.androidRuntime.platform, 'android');
    assert.deepEqual(requests, ['/api/metro/bridge']);

    const written = JSON.parse(readFileSync(runtimeFilePath, 'utf8')) as typeof result;
    assert.equal(written.iosRuntime.metroHost, 'runtime-1.metro.agent-device.dev');
    assert.equal(written.iosRuntime.metroPort, 443);
    assert.equal(written.iosRuntime.platform, 'ios');
    assert.equal(written.androidRuntime.metroHost, 'bridge.example.test');
    assert.equal(written.androidRuntime.platform, 'android');
    assert.equal(written.runtimeFilePath, runtimeFilePath);
    assert.deepEqual(readMetroSessionFixture({ stateDir: tempRoot, session: 'bridge' }), {
      controlBaseUrl: `http://127.0.0.1:${metroPort}/`,
      deviceBaseUrls: ['https://runtime-1.metro.agent-device.dev/'],
    });
    assert.equal((await client.metro.reload()).body, 'RELOADED');
  } finally {
    process.env.PATH = previousPath;
    for (const socket of proxySockets) {
      socket.destroy();
    }
    await closeLoopbackServer(proxyServer);
    await stopTestMetroProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('metro reload targets the dev server bound by metro prepare in the same session', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-metro-session');
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');
  const stateDir = path.join(tempRoot, 'state');
  const metroPort = await findFreeMetroPort();

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-session-hints-test',
      private: true,
      dependencies: { 'react-native': '0.0.0-test' },
    }),
  );
  writeFakeMetroNpx(binDir);

  const client = createAgentDeviceClient(
    { session: 'metro-session-hints', stateDir, cwd: projectRoot },
    {
      // Only session close may reach the daemon; metro prepare/reload must stay local.
      transport: async (req) => {
        if (req.command === 'close') return { ok: true, data: {} };
        throw new Error('metro prepare/reload must stay local and never call the daemon');
      },
    },
  );

  // The public MetroPrepareOptions doesn't expose env, so the fake npx must be on the real PATH.
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;

  let pid = 0;
  try {
    const prepared = await client.metro.prepare({
      projectRoot,
      publicBaseUrl: `http://127.0.0.1:${metroPort}`,
      port: metroPort,
      reuseExisting: false,
      installDependenciesIfNeeded: false,
    });
    pid = prepared.pid;

    const storedHints = readMetroSessionFixture({
      stateDir: resolveDaemonPaths(stateDir).baseDir,
      session: 'metro-session-hints',
    });
    assert.deepEqual(storedHints, {
      controlBaseUrl: `http://127.0.0.1:${metroPort}/`,
      deviceBaseUrls: [`http://127.0.0.1:${metroPort}/`],
    });

    // No explicit --metro-host/--metro-port/--bundle-url: reload must resolve against the
    // dev server this session's `metro prepare` bound, not the Metro default (localhost:8081).
    const hintedReload = await client.metro.reload();
    assert.equal(hintedReload.reloadUrl, `http://127.0.0.1:${metroPort}/reload`);
    assert.equal(hintedReload.body, 'RELOADED');

    // Regression (prepare -> close -> same-name session): close clears the binding, so a later
    // flagless reload resolves to the Metro default instead of silently hitting the stale port.
    await client.sessions.close();
    assert.equal(
      readMetroSessionFixture({
        stateDir: resolveDaemonPaths(stateDir).baseDir,
        session: 'metro-session-hints',
      }),
      undefined,
    );
  } finally {
    process.env.PATH = previousPath;
    await stopTestMetroProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('metro prepare keeps a public Expo address separate from the local reload address', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-metro-expo-session');
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');
  const stateDir = path.join(tempRoot, 'state');
  const metroPort = await findFreeMetroPort();
  const publicBasePath = '/metro/runtime-expo';

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'metro-expo-session-test',
      private: true,
      dependencies: { expo: '51.0.0', 'react-native': '0.0.0-test' },
    }),
  );
  writeFakeMetroNpx(binDir);

  const client = createAgentDeviceClient(
    { session: 'metro-expo-session', stateDir, cwd: projectRoot },
    {
      transport: async () => {
        throw new Error('metro prepare/reload must stay local and never call the daemon');
      },
    },
  );

  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ''}`;

  let pid = 0;
  try {
    const prepared = await client.metro.prepare({
      projectRoot,
      kind: 'expo',
      publicBaseUrl: `https://127.0.0.1:${metroPort}${publicBasePath}`,
      port: metroPort,
      reuseExisting: false,
      installDependenciesIfNeeded: false,
    });
    pid = prepared.pid;

    const nextClient = createAgentDeviceClient(
      {
        session: 'metro-expo-session',
        stateDir,
        cwd: projectRoot,
        runtime: prepared.iosRuntime,
      },
      {
        transport: async (request) => {
          assert.equal(request.command, 'open');
          assert.deepEqual(request.runtime, prepared.iosRuntime);
          return { ok: true, data: {} };
        },
      },
    );
    await nextClient.apps.open({ app: 'com.example.expo' });
    const hintedReload = await nextClient.metro.reload();
    assert.equal(hintedReload.reloadUrl, `http://127.0.0.1:${metroPort}/reload`);
    assert.equal(hintedReload.body, 'RELOADED');
    assert.equal(hintedReload.transport, 'http');
    assert.equal(
      prepared.iosRuntime.bundleUrl,
      `https://127.0.0.1:${metroPort}${publicBasePath}/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&minify=false`,
    );

    const storedHints = readMetroSessionFixture({
      stateDir: resolveDaemonPaths(stateDir).baseDir,
      session: 'metro-expo-session',
    });
    assert.deepEqual(storedHints, {
      controlBaseUrl: `http://127.0.0.1:${metroPort}/`,
      deviceBaseUrls: [`https://127.0.0.1:${metroPort}${publicBasePath}`],
    });
  } finally {
    process.env.PATH = previousPath;
    await stopTestMetroProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

describe('SDK open Metro session binding', () => {
  test.for([false, true])(
    'config defaults replace a stale binding only on a fresh open (reused=%s)',
    async (sessionReused, t) => {
      if (await skipWhenLoopbackUnavailable(t)) return;
      const stateDir = mkdtempForTestSync('agent-device-metro-open-');
      const previous = createServer((_req, res) => res.end('PREVIOUS'));
      const current = createServer((_req, res) => res.end('CURRENT'));
      try {
        const previousPort = await listenOnLoopback(previous);
        const currentPort = await listenOnLoopback(current);
        writeMetroSessionFixture({
          stateDir,
          session: 'proj-a',
          hints: {
            controlBaseUrl: `http://127.0.0.1:${previousPort}/`,
          },
        });
        const client = createAgentDeviceClient(
          {
            stateDir,
            session: 'proj-a',
            runtime: { metroHost: '127.0.0.1', metroPort: currentPort },
          },
          { transport: async () => ({ ok: true, data: { sessionReused } }) },
        );
        await client.apps.open({ app: 'MyApp' });
        const result = await client.metro.reload();
        expect(result.reloadUrl).toBe(
          `http://127.0.0.1:${sessionReused ? previousPort : currentPort}/reload`,
        );
        expect(result.body).toBe(sessionReused ? 'PREVIOUS' : 'CURRENT');
      } finally {
        await closeLoopbackServer(previous);
        await closeLoopbackServer(current);
      }
    },
  );
});
