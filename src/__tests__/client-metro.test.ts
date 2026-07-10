import { test } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { prepareMetroRuntime, reloadMetro } from '../metro/client-metro.ts';
import { resolveMetroReloadEndpoints } from '../metro/metro-reload-endpoints.ts';
import { createAgentDeviceClient } from '../client/client.ts';
import { readMetroSessionHints } from '../metro/metro-session-hints.ts';
import { resolveDaemonPaths } from '../daemon/config.ts';
import { AppError } from '../kernel/errors.ts';
import { isProcessAlive, waitForProcessExit } from '../utils/host-process.ts';

const TEST_TOKEN = 'agent-device-proxy-test-token';

test('prepareMetroRuntime starts Metro, bridges through proxy, and writes runtime file when requested', async () => {
  const tempRoot = path.join(os.tmpdir(), `agent-device-metro-${randomUUID()}`);
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');
  const runtimeFilePath = path.join(projectRoot, '.agent-device', 'metro-runtime.json');
  const metroPort = await findFreePort();
  const proxyPort = await findFreePort();
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
  writeFakeNpx(binDir);

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
              metro_bundle_url:
                'https://bridge.example.test/api/metro/runtimes/runtime-1/index.bundle?platform=android&dev=true&minify=false',
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

  try {
    const result = await prepareMetroRuntime({
      projectRoot,
      publicBaseUrl: `http://127.0.0.1:${metroPort}`,
      proxyBaseUrl: `http://127.0.0.1:${proxyPort}`,
      proxyBearerToken: TEST_TOKEN,
      bridgeScope: {
        tenantId: 'tenant-1',
        runId: 'run-1',
        leaseId: 'lease-1',
      },
      metroPort,
      reuseExisting: false,
      installDependenciesIfNeeded: false,
      runtimeFilePath,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
      },
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

    const written = JSON.parse(readFileSync(runtimeFilePath, 'utf8')) as {
      iosRuntime: { metroHost?: string; metroPort?: number; platform?: string };
      androidRuntime: { metroHost?: string; metroPort?: number; platform?: string };
      runtimeFilePath?: string;
    };
    assert.equal(written.iosRuntime.metroHost, 'runtime-1.metro.agent-device.dev');
    assert.equal(written.iosRuntime.metroPort, 443);
    assert.equal(written.iosRuntime.platform, 'ios');
    assert.equal(written.androidRuntime.metroHost, 'bridge.example.test');
    assert.equal(written.androidRuntime.platform, 'android');
    assert.equal(written.runtimeFilePath, runtimeFilePath);
  } finally {
    for (const socket of proxySockets) {
      socket.destroy();
    }
    await closeServer(proxyServer);
    await stopProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

for (const { configFileName, commandName } of [
  { configFileName: 'rspack.config.ts', commandName: 'rspack-start' },
  { configFileName: 'webpack.config.js', commandName: 'webpack-start' },
]) {
  test(`prepareMetroRuntime starts Re.Pack with ${commandName} for ${configFileName}`, async () => {
    const tempRoot = path.join(os.tmpdir(), `agent-device-repack-${randomUUID()}`);
    const projectRoot = path.join(tempRoot, 'project');
    const binDir = path.join(tempRoot, 'bin');
    const argsFile = path.join(tempRoot, 'npx-args.json');
    const metroPort = await findFreePort();

    mkdirSync(projectRoot, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({
        name: 'repack-runtime-test',
        private: true,
        dependencies: {
          'react-native': '0.0.0-test',
        },
        devDependencies: {
          '@callstack/repack': '5.2.5',
        },
      }),
    );
    writeFileSync(path.join(projectRoot, configFileName), 'module.exports = {};\n');
    writeFakeNpx(binDir);

    let pid = 0;
    try {
      const result = await prepareMetroRuntime({
        projectRoot,
        publicBaseUrl: `http://127.0.0.1:${metroPort}`,
        metroPort,
        reuseExisting: false,
        installDependenciesIfNeeded: false,
        env: {
          ...process.env,
          AGENT_DEVICE_TEST_NPX_ARGS_FILE: argsFile,
          PATH: `${binDir}:${process.env.PATH || ''}`,
        },
      });

      pid = result.pid;
      assert.equal(result.kind, 'repack');
      assert.equal(result.started, true);
      assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), [
        'react-native',
        commandName,
        '--host',
        '0.0.0.0',
        '--port',
        String(metroPort),
      ]);
      assert.equal(
        result.iosRuntime.bundleUrl,
        `http://127.0.0.1:${metroPort}/index.bundle?platform=ios&dev=true&minify=false`,
      );
    } finally {
      await stopProcess(pid);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('prepareMetroRuntime maps kind=expo to the virtual-metro-entry bundle URL', async () => {
  const tempRoot = path.join(os.tmpdir(), `agent-device-expo-kind-${randomUUID()}`);
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');
  const metroPort = await findFreePort();

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'expo-kind-test',
      private: true,
      dependencies: { expo: '51.0.0', 'react-native': '0.0.0-test' },
    }),
  );
  writeFakeNpx(binDir);

  let pid = 0;
  try {
    const result = await prepareMetroRuntime({
      projectRoot,
      kind: 'expo',
      publicBaseUrl: `http://127.0.0.1:${metroPort}`,
      metroPort,
      reuseExisting: false,
      installDependenciesIfNeeded: false,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
      },
    });
    pid = result.pid;

    assert.equal(result.kind, 'expo');
    assert.equal(
      result.iosRuntime.bundleUrl,
      `http://127.0.0.1:${metroPort}/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&minify=false`,
    );
    assert.equal(
      result.androidRuntime.bundleUrl,
      `http://127.0.0.1:${metroPort}/.expo/.virtual-metro-entry.bundle?platform=android&dev=true&minify=false`,
    );
    assert.ok(!result.iosRuntime.bundleUrl.includes('index.bundle'));
  } finally {
    await stopProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime keeps index.bundle for non-expo kinds', async () => {
  const tempRoot = path.join(os.tmpdir(), `agent-device-rn-kind-${randomUUID()}`);
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');
  const metroPort = await findFreePort();

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'rn-kind-test',
      private: true,
      dependencies: { 'react-native': '0.0.0-test' },
    }),
  );
  writeFakeNpx(binDir);

  let pid = 0;
  try {
    const result = await prepareMetroRuntime({
      projectRoot,
      kind: 'react-native',
      publicBaseUrl: `http://127.0.0.1:${metroPort}`,
      metroPort,
      reuseExisting: false,
      installDependenciesIfNeeded: false,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
      },
    });
    pid = result.pid;

    assert.equal(
      result.iosRuntime.bundleUrl,
      `http://127.0.0.1:${metroPort}/index.bundle?platform=ios&dev=true&minify=false`,
    );
  } finally {
    await stopProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime detects the package manager from an ancestor lockfile in a monorepo', async () => {
  const tempRoot = path.join(os.tmpdir(), `agent-device-pm-detect-${randomUUID()}`);
  const monorepoRoot = path.join(tempRoot, 'monorepo');
  const projectRoot = path.join(monorepoRoot, 'example');
  const binDir = path.join(tempRoot, 'bin');
  const argsFile = path.join(tempRoot, 'yarn-args.json');
  const metroPort = await findFreePort();

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // The lockfile lives at the monorepo root, not inside the leaf "example" project root, as with
  // a real Yarn workspaces layout.
  writeFileSync(path.join(monorepoRoot, 'yarn.lock'), '');
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'example',
      private: true,
      dependencies: { 'react-native': '0.0.0-test', 'shared-lib': 'workspace:*' },
    }),
  );
  writeFakeNpx(binDir);
  writeFakePackageManager(binDir, 'yarn', argsFile);
  writeFakePackageManager(binDir, 'npm', path.join(tempRoot, 'npm-args.json'));

  let pid = 0;
  try {
    const result = await prepareMetroRuntime({
      projectRoot,
      publicBaseUrl: `http://127.0.0.1:${metroPort}`,
      metroPort,
      reuseExisting: false,
      installDependenciesIfNeeded: true,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH || ''}`,
      },
    });
    pid = result.pid;

    assert.equal(result.packageManager, 'yarn');
    assert.equal(result.dependenciesInstalled, true);
    assert.deepEqual(JSON.parse(readFileSync(argsFile, 'utf8')), ['install']);
  } finally {
    await stopProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime install failure hints at --no-install-deps and the detected package manager', async () => {
  const tempRoot = path.join(os.tmpdir(), `agent-device-pm-fail-${randomUUID()}`);
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(projectRoot, 'yarn.lock'), '');
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'pm-fail-test',
      private: true,
      dependencies: { 'react-native': '0.0.0-test' },
    }),
  );
  writeFailingPackageManager(binDir, 'yarn');

  await assert.rejects(
    () =>
      prepareMetroRuntime({
        projectRoot,
        publicBaseUrl: 'http://127.0.0.1:9',
        installDependenciesIfNeeded: true,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH || ''}`,
        },
      }),
    (error) => {
      assert.ok(error instanceof AppError);
      const hint = error.details?.hint;
      assert.ok(typeof hint === 'string' && hint.includes('--no-install-deps'));
      assert.ok(typeof hint === 'string' && hint.includes('yarn'));
      assert.equal(error.details?.packageManager, 'yarn');
      return true;
    },
  );

  rmSync(tempRoot, { recursive: true, force: true });
});

test('prepareMetroRuntime detects bun from the text bun.lock lockfile', async () => {
  const tempRoot = path.join(os.tmpdir(), `agent-device-pm-bun-${randomUUID()}`);
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(binDir, { recursive: true });
  writeFileSync(path.join(projectRoot, 'bun.lock'), '');
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'pm-bun-test',
      private: true,
      dependencies: { 'react-native': '0.0.0-test' },
    }),
  );
  writeFailingPackageManager(binDir, 'bun');

  await assert.rejects(
    () =>
      prepareMetroRuntime({
        projectRoot,
        publicBaseUrl: 'http://127.0.0.1:9',
        installDependenciesIfNeeded: true,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH || ''}`,
        },
      }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.packageManager, 'bun');
      return true;
    },
  );

  rmSync(tempRoot, { recursive: true, force: true });
});

test('prepareMetroRuntime lockfile walk-up stops at the repo root instead of adopting an outside lockfile', async () => {
  const tempRoot = path.join(os.tmpdir(), `agent-device-pm-bound-${randomUUID()}`);
  const repoRoot = path.join(tempRoot, 'repo');
  const projectRoot = path.join(repoRoot, 'example');
  const binDir = path.join(tempRoot, 'bin');

  mkdirSync(projectRoot, { recursive: true });
  mkdirSync(path.join(repoRoot, '.git'), { recursive: true });
  mkdirSync(binDir, { recursive: true });
  // A lockfile ABOVE the repo root must not be adopted; detection falls back to npm.
  writeFileSync(path.join(tempRoot, 'yarn.lock'), '');
  writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'pm-bound-test',
      private: true,
      dependencies: { 'react-native': '0.0.0-test' },
    }),
  );
  writeFakePackageManager(binDir, 'yarn', path.join(tempRoot, 'yarn-args.json'));
  writeFailingPackageManager(binDir, 'npm');

  await assert.rejects(
    () =>
      prepareMetroRuntime({
        projectRoot,
        publicBaseUrl: 'http://127.0.0.1:9',
        installDependenciesIfNeeded: true,
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH || ''}`,
        },
      }),
    (error) => {
      assert.ok(error instanceof AppError);
      assert.equal(error.details?.packageManager, 'npm');
      return true;
    },
  );

  rmSync(tempRoot, { recursive: true, force: true });
});

test('prepareMetroRuntime rejects incomplete proxy configuration', async () => {
  await assert.rejects(
    () =>
      prepareMetroRuntime({
        publicBaseUrl: 'https://sandbox.example.test',
        proxyBaseUrl: 'https://proxy.example.test',
        env: {},
      }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('AGENT_DEVICE_METRO_BEARER_TOKEN'),
  );

  await assert.rejects(
    () =>
      prepareMetroRuntime({
        publicBaseUrl: 'https://sandbox.example.test',
        env: { AGENT_DEVICE_METRO_BEARER_TOKEN: TEST_TOKEN },
      }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('requires --proxy-base-url'),
  );

  await assert.rejects(
    () =>
      prepareMetroRuntime({
        publicBaseUrl: 'https://sandbox.example.test',
        proxyBaseUrl: 'https://proxy.example.test',
        proxyBearerToken: TEST_TOKEN,
        env: {},
      }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('tenantId, runId, and leaseId bridge scope'),
  );
});

test('prepareMetroRuntime falls back to daemon auth token for proxy auth', async () => {
  await assert.rejects(
    () =>
      prepareMetroRuntime({
        publicBaseUrl: 'https://sandbox.example.test',
        proxyBaseUrl: 'https://proxy.example.test',
        env: { AGENT_DEVICE_DAEMON_AUTH_TOKEN: TEST_TOKEN },
      }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('tenantId, runId, and leaseId bridge scope'),
  );
});

test('prepareMetroRuntime honors metro bearer token env for proxy auth', async () => {
  await assert.rejects(
    () =>
      prepareMetroRuntime({
        publicBaseUrl: 'https://sandbox.example.test',
        proxyBaseUrl: 'https://proxy.example.test',
        env: { AGENT_DEVICE_METRO_BEARER_TOKEN: TEST_TOKEN },
      }),
    (error) =>
      error instanceof AppError &&
      error.code === 'INVALID_ARGS' &&
      error.message.includes('tenantId, runId, and leaseId bridge scope'),
  );
});

test('reloadMetro preserves the bundle URL route prefix', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/metro/runtime-1/reload') {
      res.statusCode = 200;
      res.end('OK');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const result = await reloadMetro({
      bundleUrl: `http://127.0.0.1:${address.port}/metro/runtime-1/index.bundle?platform=ios&dev=true`,
      timeoutMs: 1_000,
    });

    assert.deepEqual(requests, ['/metro/runtime-1/reload']);
    assert.deepEqual(result, {
      reloaded: true,
      reloadUrl: `http://127.0.0.1:${address.port}/metro/runtime-1/reload`,
      status: 200,
      body: 'OK',
      transport: 'http',
    });
  } finally {
    await closeServer(server);
  }
});

test('reloadMetro preserves a path-prefixed Expo virtual-entry bundle URL supplied through --bundle-url', async () => {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    requests.push(req.url ?? '');
    if (req.url === '/metro/runtime-1/reload') {
      res.statusCode = 200;
      res.end('OK');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const result = await reloadMetro({
      bundleUrl: `http://127.0.0.1:${address.port}/metro/runtime-1/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true`,
      timeoutMs: 1_000,
    });

    assert.deepEqual(requests, ['/metro/runtime-1/reload']);
    assert.deepEqual(result, {
      reloaded: true,
      reloadUrl: `http://127.0.0.1:${address.port}/metro/runtime-1/reload`,
      status: 200,
      body: 'OK',
      transport: 'http',
    });
  } finally {
    await closeServer(server);
  }
});

test('reloadMetro defaults to local Metro host and port', async () => {
  const server = createServer((req, res) => {
    if (req.url === '/reload') {
      res.statusCode = 200;
      res.end('OK');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.listen(0);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const result = await reloadMetro({ metroPort: address.port, timeoutMs: 1_000 });
    assert.equal(result.reloadUrl, `http://localhost:${address.port}/reload`);
    assert.equal(result.body, 'OK');
  } finally {
    await closeServer(server);
  }
});

test('reload endpoint resolution prioritizes explicit flags, then session runtime hints, then defaults', () => {
  // no-hint default: neither an explicit flag nor a runtime hint is present.
  assert.equal(resolveMetroReloadEndpoints({}).reloadUrl, 'http://localhost:8081/reload');

  // hint-only: a session runtime hint resolves the target when no flag is given.
  assert.equal(
    resolveMetroReloadEndpoints({ runtime: { metroHost: '127.0.0.1', metroPort: 9200 } }).reloadUrl,
    'http://127.0.0.1:9200/reload',
  );

  // flag-overrides-hint: an explicit flag wins over a conflicting session runtime hint.
  assert.equal(
    resolveMetroReloadEndpoints({
      metroHost: '10.0.0.5',
      metroPort: 9300,
      runtime: { metroHost: '127.0.0.1', metroPort: 9200 },
    }).reloadUrl,
    'http://10.0.0.5:9300/reload',
  );

  // A single explicit flag still overrides only its own field; the hint fills the rest.
  assert.equal(
    resolveMetroReloadEndpoints({
      metroPort: 9400,
      runtime: { metroHost: '192.168.1.5', metroPort: 9200 },
    }).reloadUrl,
    'http://192.168.1.5:9400/reload',
  );
});

test('resolveMetroReloadEndpoints keeps the bundle URL mount prefix instead of collapsing to the host root', () => {
  // Expo virtual entry at the server root: the entry-module path is not a mount prefix, so the
  // endpoints live at the root (verified live: Expo serves /message at the server root).
  assert.deepEqual(
    resolveMetroReloadEndpoints({
      runtime: {
        metroHost: '127.0.0.1',
        metroPort: 8082,
        bundleUrl:
          'http://127.0.0.1:8082/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&minify=false',
      },
    }),
    {
      reloadUrl: 'http://127.0.0.1:8082/reload',
      messageSocketUrl: 'ws://127.0.0.1:8082/message',
    },
  );

  // Proxy/mount prefix carrying the Expo virtual entry keeps the mount prefix only.
  assert.deepEqual(
    resolveMetroReloadEndpoints({
      bundleUrl:
        'http://proxy.example.test/tenant-42/.expo/.virtual-metro-entry.bundle?platform=android',
    }),
    {
      reloadUrl: 'http://proxy.example.test/tenant-42/reload',
      messageSocketUrl: 'ws://proxy.example.test/tenant-42/message',
    },
  );

  // Proxy/mount prefix carrying a plain index.bundle keeps the prefix (Re.Pack/RN over a proxy);
  // https maps the message socket to wss.
  assert.deepEqual(
    resolveMetroReloadEndpoints({
      bundleUrl: 'https://proxy.example.test/metro/runtime-1/index.bundle?platform=ios',
    }),
    {
      reloadUrl: 'https://proxy.example.test/metro/runtime-1/reload',
      messageSocketUrl: 'wss://proxy.example.test/metro/runtime-1/message',
    },
  );

  // Root index.bundle still reloads at the host root.
  assert.deepEqual(
    resolveMetroReloadEndpoints({
      bundleUrl: 'http://127.0.0.1:8081/index.bundle?platform=ios',
    }),
    {
      reloadUrl: 'http://127.0.0.1:8081/reload',
      messageSocketUrl: 'ws://127.0.0.1:8081/message',
    },
  );
});

test('metro reload targets the dev server bound by metro prepare in the same session', async () => {
  const tempRoot = path.join(os.tmpdir(), `agent-device-metro-session-${randomUUID()}`);
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');
  const stateDir = path.join(tempRoot, 'state');
  const metroPort = await findFreePort();

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
  writeFakeNpx(binDir);

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

    const storedHints = readMetroSessionHints({
      stateDir: resolveDaemonPaths(stateDir).baseDir,
      session: 'metro-session-hints',
    });
    assert.deepEqual(storedHints, {
      metroHost: '127.0.0.1',
      metroPort,
      bundleUrl: `http://127.0.0.1:${metroPort}/index.bundle?platform=ios&dev=true&minify=false`,
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
      readMetroSessionHints({
        stateDir: resolveDaemonPaths(stateDir).baseDir,
        session: 'metro-session-hints',
      }),
      undefined,
    );
    assert.equal(resolveMetroReloadEndpoints({}).reloadUrl, 'http://localhost:8081/reload');
  } finally {
    process.env.PATH = previousPath;
    await stopProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('metro prepare --kind expo keeps a prefixed public base URL for session reload', async () => {
  const tempRoot = path.join(os.tmpdir(), `agent-device-metro-expo-session-${randomUUID()}`);
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');
  const stateDir = path.join(tempRoot, 'state');
  const metroPort = await findFreePort();
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
  writeFakeNpx(binDir, `${publicBasePath}/reload`);

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
      publicBaseUrl: `http://127.0.0.1:${metroPort}${publicBasePath}`,
      port: metroPort,
      reuseExisting: false,
      installDependenciesIfNeeded: false,
    });
    pid = prepared.pid;

    const storedHints = readMetroSessionHints({
      stateDir: resolveDaemonPaths(stateDir).baseDir,
      session: 'metro-expo-session',
    });
    assert.deepEqual(storedHints, {
      metroHost: '127.0.0.1',
      metroPort,
      bundleUrl: `http://127.0.0.1:${metroPort}${publicBasePath}/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&minify=false`,
    });

    // The fake Metro process only serves this prefixed endpoint. A reload that discarded the
    // public-base mount would receive 404 and fail its websocket fallback.
    const hintedReload = await client.metro.reload();
    assert.equal(hintedReload.reloadUrl, `http://127.0.0.1:${metroPort}${publicBasePath}/reload`);
    assert.equal(hintedReload.body, 'RELOADED');
    assert.equal(hintedReload.transport, 'http');
  } finally {
    process.env.PATH = previousPath;
    await stopProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('reloadMetro falls back to the /message websocket when the HTTP route answers with the app page', async () => {
  const receivedMessages: string[] = [];
  const upgradedSockets = new Set<import('node:stream').Duplex>();
  const server = createServer((req, res) => {
    if (req.url === '/reload') {
      // Expo-style: no HTTP reload route; the SPA fallback answers with the app page.
      res.statusCode = 200;
      res.setHeader('content-type', 'text/html');
      res.end('<!DOCTYPE html>\n<html><body>app page</body></html>');
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  server.on('upgrade', (req, socket) => {
    if (req.url !== '/message') {
      socket.destroy();
      return;
    }
    // Upgraded sockets leave the server's connection tracking; keep them for teardown.
    upgradedSockets.add(socket);
    socket.on('close', () => upgradedSockets.delete(socket));
    const key = req.headers['sec-websocket-key'] ?? '';
    const accept = createHash('sha1')
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    socket.on('data', (frame: Buffer) => {
      const text = decodeMaskedTextFrame(frame);
      if (text) receivedMessages.push(text);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');

  try {
    const result = await reloadMetro({
      bundleUrl: `http://127.0.0.1:${address.port}/.expo/.virtual-metro-entry.bundle?platform=ios`,
      timeoutMs: 3_000,
    });

    assert.equal(result.transport, 'message-socket');
    assert.equal(result.reloadUrl, `ws://127.0.0.1:${address.port}/message`);
    assert.deepEqual(
      receivedMessages.map((message) => JSON.parse(message)),
      [{ version: 2, method: 'reload' }],
    );
  } finally {
    for (const socket of upgradedSockets) {
      socket.destroy();
    }
    await closeServer(server);
  }
});

// Minimal RFC 6455 decode for one small (<126 byte) masked client text frame; enough for the
// single broadcast message this suite sends without adding a websocket-server dependency.
function decodeMaskedTextFrame(frame: Buffer): string | null {
  if (frame.length < 6) return null;
  const opcode = frame[0]! & 0x0f;
  if (opcode !== 0x1) return null;
  const length = frame[1]! & 0x7f;
  if (length > 125 || frame.length < 6 + length) return null;
  const mask = frame.subarray(2, 6);
  const payload = Buffer.from(frame.subarray(6, 6 + length));
  for (let i = 0; i < payload.length; i += 1) {
    payload[i] = payload[i]! ^ mask[i % 4]!;
  }
  return payload.toString('utf8');
}

function writeFakePackageManager(binDir: string, name: string, argsFile: string): void {
  const filePath = path.join(binDir, name);
  writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require("node:fs")
fs.writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(2)))
process.exit(0)
`,
  );
  chmodSync(filePath, 0o755);
}

function writeFailingPackageManager(binDir: string, name: string): void {
  const filePath = path.join(binDir, name);
  writeFileSync(
    filePath,
    `#!/usr/bin/env node
process.stderr.write("npm error EUNSUPPORTEDPROTOCOL Unsupported URL Type \\"workspace:\\": workspace:*\\n")
process.exit(1)
`,
  );
  chmodSync(filePath, 0o755);
}

function writeFakeNpx(binDir: string, reloadPath = '/reload'): void {
  const filePath = path.join(binDir, 'npx');
  writeFileSync(
    filePath,
    `#!/usr/bin/env node
const fs = require("node:fs")
const http = require("node:http")
const args = process.argv.slice(2)
if (process.env.AGENT_DEVICE_TEST_NPX_ARGS_FILE) {
  fs.writeFileSync(process.env.AGENT_DEVICE_TEST_NPX_ARGS_FILE, JSON.stringify(args))
}
const portIndex = args.indexOf("--port")
const hostIndex = args.indexOf("--host")
const port = portIndex === -1 ? 8081 : Number(args[portIndex + 1] || "8081")
// "expo start" takes a connectivity mode ("lan", "tunnel", "localhost") for --host, not a bind
// address; every other caller (react-native/rspack/webpack start) passes a real bind address.
const rawHost = hostIndex === -1 ? "0.0.0.0" : String(args[hostIndex + 1] || "0.0.0.0")
const host = rawHost === "lan" || rawHost === "tunnel" ? "0.0.0.0" : rawHost
const reloadPath = ${JSON.stringify(reloadPath)}
const server = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.statusCode = 200
    res.end("packager-status:running")
    return
  }
  if (req.url && (req.url.startsWith("/index.bundle") || req.url.includes(".virtual-metro-entry.bundle"))) {
    res.statusCode = 200
    res.setHeader("content-type", "application/javascript")
    res.end("console.log('metro-runtime-test')")
    return
  }
  if (req.url === reloadPath) {
    res.statusCode = 200
    res.end("RELOADED")
    return
  }
  res.statusCode = 404
  res.end("not found")
})
server.listen(port, host)
setInterval(() => {}, 1000)
`,
  );
  chmodSync(filePath, 0o755);
}

async function findFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to allocate free port'));
        return;
      }
      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(port);
      });
    });
  });
}

async function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

async function stopProcess(pid: number): Promise<void> {
  if (!pid || !isProcessAlive(pid)) return;
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return;
  }
  if (await waitForProcessExit(pid, 1_500)) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    return;
  }
  await waitForProcessExit(pid, 1_500);
}
