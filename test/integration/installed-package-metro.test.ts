import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { closeLoopbackServer, listenOnLoopback } from '../../src/__tests__/test-utils/loopback.ts';
import { runCmd, runCmdSync } from '../../src/utils/exec.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SUBPROCESS_TIMEOUT_MS = 120_000;

function destroySocket(socket: Duplex | null): void {
  socket?.destroy();
}

function readJson(stdout: string): any {
  return JSON.parse(stdout);
}

async function execFileText(
  file: string,
  args: string[],
  options: { cwd: string },
): Promise<string> {
  const result = await runCmd(file, args, {
    cwd: options.cwd,
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
  return result.stdout;
}

function packInstalledPackage(tempRoot: string): string {
  const packDir = path.join(tempRoot, 'pack');
  fs.mkdirSync(packDir, { recursive: true });
  const result = runCmdSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir], {
    cwd: repoRoot,
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
  const tarballName = result.stdout.trim();
  return path.join(packDir, tarballName);
}

function ensureBuiltPackage(): void {
  const distMetroPath = path.join(repoRoot, 'dist', 'src', 'metro.js');
  if (fs.existsSync(distMetroPath)) return;

  runCmdSync('pnpm', ['build'], {
    cwd: repoRoot,
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
}

function extractInstalledPackage(tarballPath: string, consumerRoot: string): string {
  const nodeModulesRoot = path.join(consumerRoot, 'node_modules');
  fs.mkdirSync(nodeModulesRoot, { recursive: true });
  runCmdSync('tar', ['-xzf', tarballPath, '-C', nodeModulesRoot], {
    cwd: consumerRoot,
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
  const extractedPackageRoot = path.join(nodeModulesRoot, 'package');
  const installedPackageRoot = path.join(nodeModulesRoot, 'agent-device');
  fs.renameSync(extractedPackageRoot, installedPackageRoot);
  return installedPackageRoot;
}

function linkRuntimeDependencies(installedPackageRoot: string, consumerRoot: string): void {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(installedPackageRoot, 'package.json'), 'utf8'),
  ) as {
    dependencies?: Record<string, string>;
  };
  const consumerNodeModules = path.join(consumerRoot, 'node_modules');
  for (const dependencyName of Object.keys(packageJson.dependencies ?? {})) {
    const sourcePath = path.join(repoRoot, 'node_modules', dependencyName);
    const targetPath = path.join(consumerNodeModules, dependencyName);
    if (!fs.existsSync(sourcePath) || fs.existsSync(targetPath)) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.symlinkSync(sourcePath, targetPath, 'junction');
  }
}

async function runNodeModuleJson(cwd: string, args: string[], script: string): Promise<any> {
  const stdout = await execFileText(process.execPath, [...args, script], {
    cwd,
  });
  return readJson(stdout);
}

function acceptWebSocket(socket: Duplex, key: string): void {
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${accept}`,
      '\r\n',
    ].join('\r\n'),
  );
}

test('installed package exposes Node APIs and packaged companion tunnel entrypoint', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-installed-package-'));
  const consumerRoot = path.join(root, 'consumer');
  const projectRoot = path.join(root, 'project');
  const configDir = path.join(root, 'config');
  fs.mkdirSync(consumerRoot, { recursive: true });
  fs.mkdirSync(projectRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(consumerRoot, 'package.json'), '{"type":"module"}\n', 'utf8');
  fs.mkdirSync(path.join(projectRoot, 'node_modules'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'package.json'),
    JSON.stringify({
      name: 'installed-package-metro-test',
      private: true,
      dependencies: {
        'react-native': '0.0.0-test',
      },
    }),
    'utf8',
  );

  let installedPackageRoot = '';
  let remoteConfigPath = '';
  const metroServer = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('packager-status:running');
      return;
    }
    res.writeHead(404);
    res.end('not found');
  });
  let bridgeSocketRef: Duplex | null = null;
  const bridgeToken = 'bridge-token';
  let bridgeRegistered = false;
  let bridgeRequestCount = 0;
  let bridgePort = 0;
  const bridgeServer = http.createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/api/metro/bridge') {
      bridgeRequestCount += 1;
      if (!bridgeRegistered) {
        res.writeHead(409, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Metro companion is not connected' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: {
            enabled: true,
            base_url: `http://127.0.0.1:${bridgePort}`,
            status_url: `http://127.0.0.1:${metroPort}/status`,
            bundle_url: 'https://demo.metro.agent-device.dev/index.bundle?platform=ios',
            ios_runtime: {
              metro_host: 'demo.metro.agent-device.dev',
              metro_port: 443,
              metro_bundle_url: 'https://demo.metro.agent-device.dev/index.bundle?platform=ios',
            },
            android_runtime: {
              metro_host: 'bridge.example.test',
              metro_port: 443,
              metro_bundle_url:
                'https://bridge.example.test/api/metro/runtimes/demo/index.bundle?platform=android',
            },
            upstream: {
              bundle_url:
                'https://public.example.test/index.bundle?platform=ios&dev=true&minify=false',
              host: '127.0.0.1',
              port: metroPort,
              status_url: `http://127.0.0.1:${metroPort}/status`,
            },
            probe: {
              reachable: true,
              status_code: 200,
              latency_ms: 1,
              detail: 'ok',
            },
          },
        }),
      );
      return;
    }

    if (req.method === 'POST' && req.url === '/api/metro/companion/register') {
      assert.equal(req.headers.authorization, `Bearer ${bridgeToken}`);
      bridgeRegistered = true;
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            data: { ws_url: `ws://127.0.0.1:${bridgePort}/bridge` },
          }),
        );
      });
      return;
    }

    res.writeHead(404);
    res.end('not found');
  });
  let metroPort = 0;
  try {
    ensureBuiltPackage();
    const tarballPath = packInstalledPackage(root);
    installedPackageRoot = extractInstalledPackage(tarballPath, consumerRoot);
    linkRuntimeDependencies(installedPackageRoot, consumerRoot);
    assert.equal(
      fs.existsSync(
        path.join(installedPackageRoot, 'dist', 'src', 'internal', 'companion-tunnel.js'),
      ),
      true,
    );
    assert.equal(
      fs.existsSync(path.join(installedPackageRoot, 'dist', 'src', 'companion-tunnel.js')),
      false,
    );

    metroPort = await listenOnLoopback(metroServer);
    t.after(async () => {
      await closeLoopbackServer(metroServer);
    });

    bridgeServer.on('upgrade', (req, socket) => {
      if (req.url !== '/bridge') {
        socket.destroy();
        return;
      }
      const key = req.headers['sec-websocket-key'];
      if (typeof key !== 'string') {
        socket.destroy();
        return;
      }
      bridgeSocketRef = socket;
      acceptWebSocket(socket, key);
    });
    bridgePort = await listenOnLoopback(bridgeServer);
    t.after(async () => {
      destroySocket(bridgeSocketRef);
      await closeLoopbackServer(bridgeServer);
    });

    remoteConfigPath = path.join(configDir, 'demo.remote.json');
    fs.writeFileSync(
      remoteConfigPath,
      JSON.stringify({
        platform: 'ios',
        metroProjectRoot: projectRoot,
        metroProxyBaseUrl: `http://127.0.0.1:${bridgePort}`,
        metroBearerToken: bridgeToken,
        tenant: 'tenant-1',
        runId: 'run-1',
        leaseId: 'lease-1',
        metroPreparePort: metroPort,
        metroStatusHost: '127.0.0.1',
      }),
      'utf8',
    );

    const imports = await runNodeModuleJson(
      consumerRoot,
      ['--input-type=module', '-e'],
      `
        import * as agentDeviceRoot from 'agent-device';
        import 'agent-device/contracts';
        import { createLocalArtifactAdapter as createIoArtifactAdapter } from 'agent-device/io';
        import { buildBundleUrl, normalizeBaseUrl } from 'agent-device/metro';
        const client = agentDeviceRoot.createAgentDeviceClient();
        const removedSubpaths = await Promise.all([
          'agent-device/backend',
          'agent-device/commands',
          'agent-device/testing/conformance',
          'agent-device/observability',
        ].map(async (specifier) => {
          try {
            await import(specifier);
            return false;
          } catch {
            return true;
          }
        }));
        console.log(JSON.stringify({
          bundleUrl: buildBundleUrl('https://public.example.test', 'ios'),
          rootExports: Object.keys(agentDeviceRoot).sort(),
          rootClientSnapshot: typeof client.capture.snapshot,
          rootArtifactAdapter: typeof agentDeviceRoot.createLocalArtifactAdapter({
            cwd: process.cwd(),
          }).reserveOutput,
          ioArtifactAdapter: typeof createIoArtifactAdapter({ cwd: process.cwd() }).reserveOutput,
          removedSubpathsBlocked: removedSubpaths.every(Boolean),
          normalizedBaseUrl: normalizeBaseUrl('https://public.example.test///'),
          protocolBundleUrl: buildBundleUrl('https://public.example.test', 'android'),
        }));
      `,
    );
    assert.equal(
      imports.bundleUrl,
      'https://public.example.test/index.bundle?platform=ios&dev=true&minify=false',
    );
    assert.deepEqual(imports.rootExports, [
      'AppError',
      'centerOfRect',
      'createAgentDeviceClient',
      'createLocalArtifactAdapter',
      'isAgentDeviceError',
      'normalizeAgentDeviceError',
    ]);
    assert.equal(imports.rootClientSnapshot, 'function');
    assert.equal(imports.rootArtifactAdapter, 'function');
    assert.equal(imports.ioArtifactAdapter, 'function');
    assert.equal(imports.removedSubpathsBlocked, true);
    assert.equal(imports.normalizedBaseUrl, 'https://public.example.test');
    assert.equal(
      imports.protocolBundleUrl,
      'https://public.example.test/index.bundle?platform=android&dev=true&minify=false',
    );
    const cliStdout = await execFileText(
      process.execPath,
      [
        path.join(installedPackageRoot, 'bin', 'agent-device.mjs'),
        'metro',
        'prepare',
        '--remote-config',
        remoteConfigPath,
        '--json',
      ],
      { cwd: consumerRoot },
    );
    const cliResult = readJson(cliStdout);
    assert.equal(cliResult.success, true);
    assert.equal(cliResult.data.reused, true);
    assert.equal(cliResult.data.bridge.enabled, true);
    assert.equal(bridgeRegistered, true);
    assert.equal(bridgeRequestCount >= 2, true);
  } finally {
    destroySocket(bridgeSocketRef);
    await closeLoopbackServer(bridgeServer);
    await closeLoopbackServer(metroServer);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
