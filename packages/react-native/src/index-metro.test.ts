import { test } from 'vitest';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { prepareMetroRuntime, reloadMetro } from './index.ts';
import { AppError } from '@agent-device/kernel/errors';
import {
  closeLoopbackServer,
  mkdtempForTestSync,
  writeFakeMetroNpx,
  findFreeMetroPort,
  stopTestMetroProcess,
} from '@agent-device/test-kit';

const TEST_TOKEN = 'agent-device-proxy-test-token';

for (const { configFileName, commandName } of [
  { configFileName: 'rspack.config.ts', commandName: 'rspack-start' },
  { configFileName: 'webpack.config.js', commandName: 'webpack-start' },
]) {
  test(`prepareMetroRuntime starts Re.Pack with ${commandName} for ${configFileName}`, async () => {
    const tempRoot = mkdtempForTestSync('agent-device-repack');
    const projectRoot = path.join(tempRoot, 'project');
    const binDir = path.join(tempRoot, 'bin');
    const argsFile = path.join(tempRoot, 'npx-args.json');
    const metroPort = await findFreeMetroPort();

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
    writeFakeMetroNpx(binDir);

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
      await stopTestMetroProcess(pid);
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });
}

test('prepareMetroRuntime maps kind=expo to the virtual-metro-entry bundle URL', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-expo-kind');
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');
  const metroPort = await findFreeMetroPort();

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
  writeFakeMetroNpx(binDir);

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
    await stopTestMetroProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime keeps index.bundle for non-expo kinds', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-rn-kind');
  const projectRoot = path.join(tempRoot, 'project');
  const binDir = path.join(tempRoot, 'bin');
  const metroPort = await findFreeMetroPort();

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
  writeFakeMetroNpx(binDir);

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
    await stopTestMetroProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime detects the package manager from an ancestor lockfile in a monorepo', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-pm-detect');
  const monorepoRoot = path.join(tempRoot, 'monorepo');
  const projectRoot = path.join(monorepoRoot, 'example');
  const binDir = path.join(tempRoot, 'bin');
  const argsFile = path.join(tempRoot, 'yarn-args.json');
  const metroPort = await findFreeMetroPort();

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
  writeFakeMetroNpx(binDir);
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
    await stopTestMetroProcess(pid);
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('prepareMetroRuntime install failure hints at --no-install-deps and the detected package manager', async () => {
  const tempRoot = mkdtempForTestSync('agent-device-pm-fail');
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
  const tempRoot = mkdtempForTestSync('agent-device-pm-bun');
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
  const tempRoot = mkdtempForTestSync('agent-device-pm-bound');
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
    await closeLoopbackServer(server);
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
    await closeLoopbackServer(server);
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
    await closeLoopbackServer(server);
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
    await closeLoopbackServer(server);
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
