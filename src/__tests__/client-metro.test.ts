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
import { prepareMetroRuntime, reloadMetro } from '../metro/client-metro.ts';
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
const host = hostIndex === -1 ? "0.0.0.0" : String(args[hostIndex + 1] || "0.0.0.0")
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
