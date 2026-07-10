import { test } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { prepareMetroRuntime, reloadMetro, resolveMetroReloadUrl } from '../metro/client-metro.ts';
import { createAgentDeviceClient } from '../client/client.ts';
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

test('resolveMetroReloadUrl prioritizes explicit flags, then session runtime hints, then defaults', () => {
  // no-hint default: neither an explicit flag nor a runtime hint is present.
  assert.equal(resolveMetroReloadUrl({}), 'http://localhost:8081/reload');

  // hint-only: a session runtime hint resolves the target when no flag is given.
  assert.equal(
    resolveMetroReloadUrl({ runtime: { metroHost: '127.0.0.1', metroPort: 9200 } }),
    'http://127.0.0.1:9200/reload',
  );

  // flag-overrides-hint: an explicit flag wins over a conflicting session runtime hint.
  assert.equal(
    resolveMetroReloadUrl({
      metroHost: '10.0.0.5',
      metroPort: 9300,
      runtime: { metroHost: '127.0.0.1', metroPort: 9200 },
    }),
    'http://10.0.0.5:9300/reload',
  );

  // A single explicit flag still overrides only its own field; the hint fills the rest.
  assert.equal(
    resolveMetroReloadUrl({
      metroPort: 9400,
      runtime: { metroHost: '192.168.1.5', metroPort: 9200 },
    }),
    'http://192.168.1.5:9400/reload',
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
      transport: async () => {
        throw new Error('metro prepare/reload must stay local and never call the daemon');
      },
    },
  );

  // MetroPrepareOptions (the public client surface) doesn't expose `env`, so the fake `npx`
  // has to be reachable through the real PATH for the duration of this test, matching the
  // temporary-PATH pattern used elsewhere for exec-dependent tests.
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

    // No explicit --metro-host/--metro-port/--bundle-url: reload must resolve against the
    // dev server this session's `metro prepare` bound, not the Metro default (localhost:8081).
    const hintedReload = await client.metro.reload();
    assert.equal(hintedReload.reloadUrl, `http://127.0.0.1:${metroPort}/reload`);
    assert.equal(hintedReload.body, 'RELOADED');
  } finally {
    process.env.PATH = previousPath;
    await stopProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

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

function writeFakeNpx(binDir: string): void {
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
const server = http.createServer((req, res) => {
  if (req.url === "/status") {
    res.statusCode = 200
    res.end("packager-status:running")
    return
  }
  if (req.url && req.url.startsWith("/index.bundle")) {
    res.statusCode = 200
    res.setHeader("content-type", "application/javascript")
    res.end("console.log('metro-runtime-test')")
    return
  }
  if (req.url === "/reload") {
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
