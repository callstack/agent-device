import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { closeLoopbackServer, listenOnLoopback } from '@agent-device/test-kit';
import { runCmd, runCmdSync } from '@agent-device/host-kit/command';

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
  const distMetroPath = path.join(repoRoot, 'dist', 'src', 'index.js');
  if (fs.existsSync(distMetroPath)) return;

  runCmdSync('pnpm', ['build'], {
    cwd: repoRoot,
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
}

function extractInstalledPackage(
  tarballPath: string,
  consumerRoot: string,
  packageName = 'agent-device',
): string {
  const nodeModulesRoot = path.join(consumerRoot, 'node_modules');
  fs.mkdirSync(nodeModulesRoot, { recursive: true });
  runCmdSync('tar', ['-xzf', tarballPath, '-C', nodeModulesRoot], {
    cwd: consumerRoot,
    timeoutMs: SUBPROCESS_TIMEOUT_MS,
  });
  const extractedPackageRoot = path.join(nodeModulesRoot, 'package');
  const installedPackageRoot = path.join(nodeModulesRoot, packageName);
  fs.mkdirSync(path.dirname(installedPackageRoot), { recursive: true });
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

/** Compile the retained SDK names and official plugins against packed declarations. */
async function typeCheckInstalledPluginContract(consumerRoot: string): Promise<void> {
  for (const name of ['maestro', 'replay']) {
    const tarball = path.join(consumerRoot, `${name}.tgz`);
    runCmdSync('pnpm', ['pack', '--out', tarball], {
      cwd: path.join(repoRoot, 'packages', name),
      timeoutMs: SUBPROCESS_TIMEOUT_MS,
    });
    extractInstalledPackage(tarball, consumerRoot, `@agent-device/${name}`);
  }
  const source = path.join(consumerRoot, 'plugin-contract-smoke.ts');
  fs.writeFileSync(
    source,
    `import { createAgentDeviceClient, ensureDaemon, AppError, isAgentDeviceError, normalizeAgentDeviceError } from 'agent-device';
import type { AgentDeviceClient, CaptureScreenshotResult, CaptureSnapshotResult, DeviceBootOptions, LeaseAllocateOptions, LeaseScopedOptions, PressOptions, SnapshotNode } from 'agent-device';
import { defaultHintForCode } from 'agent-device/contracts';
import { parseSelectorChain, listSelectorChainMatches } from 'agent-device/selectors';
import type { AgentDevicePlugin, MacOsPlatformLeafContribution, PlatformBackgroundProcess, PlatformContribution, PlatformHost, PlatformOutputSink, PlatformSetup, PluginConnection, PluginConnectionContext, PluginRuntimeSetup, ProviderAgentDevicePlugin, ProviderPluginHost, RunHostCommand } from 'agent-device/plugins';
import maestro from '@agent-device/maestro/agent-device';
import replay from '@agent-device/replay/agent-device';
const plugins: AgentDevicePlugin[] = [maestro(), replay()];
void [plugins, createAgentDeviceClient, ensureDaemon, AppError, isAgentDeviceError, normalizeAgentDeviceError, defaultHintForCode, parseSelectorChain, listSelectorChainMatches];
type PublicTypes = [AgentDeviceClient, CaptureScreenshotResult, CaptureSnapshotResult, DeviceBootOptions, LeaseAllocateOptions, LeaseScopedOptions, PressOptions, SnapshotNode, MacOsPlatformLeafContribution, PlatformBackgroundProcess, PlatformContribution, PlatformHost, PlatformOutputSink, PlatformSetup, PluginConnection, PluginConnectionContext, PluginRuntimeSetup, ProviderAgentDevicePlugin, ProviderPluginHost, RunHostCommand];
export type { PublicTypes };
`,
  );
  await execFileText(
    process.execPath,
    [
      path.join(repoRoot, 'node_modules/typescript/bin/tsc'),
      '--noEmit',
      '--strict',
      '--target',
      'es2022',
      '--lib',
      'es2022,dom,esnext.disposable',
      '--module',
      'nodenext',
      '--moduleResolution',
      'nodenext',
      source,
    ],
    { cwd: consumerRoot },
  );
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
    assert.equal(
      fs.existsSync(path.join(installedPackageRoot, 'dist/src/internal/run-script-child.js')),
      false,
    );

    const pluginTypes = fs.readFileSync(path.join(installedPackageRoot, 'dist/src/plugins.d.ts'));
    assert.ok(pluginTypes.length < 16 * 1024);
    for (const exported of [
      'AgentDevicePlugin',
      'PluginConnection',
      'PluginRuntimeSetup',
      'ProviderPluginHost',
    ]) {
      assert.match(
        pluginTypes.toString(),
        new RegExp(`export (?:type )?\\{[^}]*\\b${exported}\\b`),
      );
    }
    await typeCheckInstalledPluginContract(consumerRoot);
    const managedHome = path.join(consumerRoot, 'managed-plugin-home');
    const replayArchive = path.join(consumerRoot, 'replay.tgz');
    const expectedIntegrity = `sha512-${crypto.createHash('sha512').update(fs.readFileSync(replayArchive)).digest('base64')}`;
    const selection = await runNodeModuleJson(
      consumerRoot,
      ['--input-type=module', '-e'],
      `import { addPluginArtifact } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'packages/plugins/src/store.ts')).href)};
       const selected = await addPluginArtifact(${JSON.stringify(replayArchive)}, {
         cwd: process.cwd(),
         env: { ...process.env, HOME: ${JSON.stringify(managedHome)}, AGENT_DEVICE_HOME: ${JSON.stringify(managedHome)} },
       });
       console.log(JSON.stringify(selected));`,
    );
    assert.equal(selection.name, '@agent-device/replay');
    assert.equal(selection.integrity, expectedIntegrity);
    const inventory = await runCmd(
      process.execPath,
      [path.join(installedPackageRoot, 'bin/agent-device.mjs'), 'plugins', 'list', '--json'],
      {
        cwd: consumerRoot,
        env: { ...process.env, HOME: managedHome, AGENT_DEVICE_HOME: managedHome },
        timeoutMs: SUBPROCESS_TIMEOUT_MS,
      },
    );
    const selectedPlugin = readJson(inventory.stdout).data.plugins.find(
      (plugin: { name?: string }) => plugin.name === '@agent-device/replay',
    );
    assert.equal(selectedPlugin?.installation, selection.installation);
    assert.equal(selectedPlugin?.integrity, expectedIntegrity);
    assert.equal(selectedPlugin?.version, selection.version);
    assert.equal(selectedPlugin?.backend, 'ad');
    assert.equal(selectedPlugin?.compatible, true);
    fs.writeFileSync(
      path.join(consumerRoot, 'fixture-plugin.mjs'),
      String.raw`
export const disposed = [];
export const setups = [];
export function fixture(provider, setupOverride) {
  return {
    apiVersion: 3,
    contributes: [{
      kind: 'provider',
      provider,
      credentials: { variables: [] },
      setup: setupOverride ?? ((host) => {
        setups.push([provider, host.env.HOST_MARKER]);
        return {
          runtime: {
            provider,
            leaseLifecycle: {},
            ownsDevice: () => false,
            getInteractor: () => undefined,
            deviceInventoryProvider: () => ({ listDevices: async () => [] }),
            shutdown: async () => {
              disposed.push(provider + ':shutdown');
            },
          },
          platformModule: {
            owner: { kind: 'provider-runtime', provider, instance: provider },
            loadRuntime: async () => ({}),
          },
          dispose: () => {
            disposed.push(provider + ':dispose');
          },
        };
      }),
    }],
  };
}
`,
    );
    const hosted = readJson(
      await execFileText(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          String.raw`
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { createAgentDeviceClient } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'packages/client/src/index.ts')).href)};
import { startAgentDevice } from ${JSON.stringify(pathToFileURL(path.join(repoRoot, 'src/host.ts')).href)};

const exec = promisify(execFile);
const cwd = process.cwd();
const beforeEnv = { ...process.env };
const listeners = ['SIGINT', 'SIGTERM', 'uncaughtException', 'unhandledRejection'];
const beforeListeners = listeners.map((event) => process.listeners(event));
import { fixture, disposed, setups } from './fixture-plugin.mjs';
fs.mkdirSync(path.join(cwd, '.agent-device'), { recursive: true });
fs.writeFileSync(path.join(cwd, '.agent-device/config.json'), '{broken plugin store');
const supplied = {
  cwd,
  env: {
    HOME: cwd,
    PATH: process.env.PATH,
    HOST_MARKER: 'A',
    AGENT_DEVICE_DAEMON_BASE_URL: 'http://127.0.0.1:9',
  },
};
const a = await startAgentDevice({
  stateDir: 'host-a',
  host: supplied,
  plugins: [
    fixture('fixture-a'),
    fixture('cloud'),
    null,
    { ...fixture('wrong-version'), apiVersion: 1 },
    fixture('broken', () => {
      throw new Error('fixture setup failure');
    }),
  ],
});
const bCwd = path.join(cwd, 'b-cwd');
fs.mkdirSync(bCwd);
const b = await startAgentDevice({
  stateDir: 'host-b',
  host: { cwd: bCwd, env: { ...supplied.env, HOST_MARKER: 'B' } },
  plugins: [fixture('fixture-b')],
});
try {
  supplied.env.HOST_MARKER = 'mutated';
  assert.deepEqual(await a.client.sessions.list(), []);
  assert.deepEqual(await b.client.sessions.list(), []);
  assert.equal(b.clientConfig.cwd, bCwd);
  assert.deepEqual(setups, [
    ['fixture-a', 'A'],
    ['fixture-b', 'B'],
  ]);
  const inventory = JSON.parse(fs.readFileSync(path.join(a.clientConfig.stateDir, 'daemon.json'), 'utf8')).plugins;
  assert.equal(inventory.find((p) => p.provider === 'fixture-a').state, 'active');
  assert.equal(
    inventory.filter((p) => p.provider === 'cloud' && p.source === 'embedder')[0].error.reason,
    'reserved_provider',
  );
  assert.equal(inventory.find((p) => p.provider === 'broken').state, 'failed');
  assert.equal(inventory.find((p) => p.source === 'embedder' && p.provider === undefined).error.reason, 'invalid_plugin');
  assert.equal(inventory.find((p) => p.provider === 'wrong-version').error.reason, 'incompatible-plugin-api');
  assert.equal(process.cwd(), cwd);
  assert.deepEqual({ ...process.env }, beforeEnv);
  assert.deepEqual(
    listeners.map((event) => process.listeners(event)),
    beforeListeners,
  );
  await assert.rejects(startAgentDevice({ stateDir: a.clientConfig.stateDir, host: supplied, plugins: [fixture('rollback')] }), (error) => error.details?.reason === 'daemon_registration_refused' && error.details?.status === 'busy');
  assert.deepEqual(disposed.splice(0), ['rollback:shutdown', 'rollback:dispose']);
  const unprovenDir = path.join(cwd, 'unproven');
  fs.mkdirSync(unprovenDir);
  fs.writeFileSync(path.join(unprovenDir, 'daemon.lock'), 'legacy lock');
  await assert.rejects(startAgentDevice({ stateDir: unprovenDir, host: supplied, plugins: [fixture('unproven')] }), (error) => error.details?.reason === 'daemon_registration_refused' && error.details?.status === 'unproven');
  assert.equal(fs.readFileSync(path.join(unprovenDir, 'daemon.lock'), 'utf8'), 'legacy lock');
  assert.deepEqual(disposed.splice(0), ['unproven:shutdown', 'unproven:dispose']);
  const config = JSON.stringify(a.clientConfig);
  const child = await exec(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      "import { createAgentDeviceClient } from " + JSON.stringify(${JSON.stringify(pathToFileURL(path.join(repoRoot, 'packages/client/src/index.ts')).href)}) + "; console.log(JSON.stringify(await createAgentDeviceClient(" + config + ").sessions.list()));",
    ],
    { cwd },
  );
  assert.deepEqual(JSON.parse(child.stdout), []);
  const cli = ${JSON.stringify(path.join(repoRoot, 'src/bin.ts'))};
  await assert.rejects(
    exec(
      process.execPath,
      ['--experimental-strip-types', cli, 'daemon', 'stop', '--clean', '--state-dir', a.clientConfig.stateDir, '--json'],
      { cwd },
    ),
    (error) => {
      assert.equal(JSON.parse(error.stdout).error.details.reason, 'daemon-clean-not-detached');
      return true;
    },
  );
  assert.deepEqual(await a.client.sessions.list(), []);
  await assert.rejects(
    exec(
      process.execPath,
      ['--experimental-strip-types', cli, 'daemon', 'stop', '--state-dir', a.clientConfig.stateDir, '--json'],
      { cwd },
    ),
    (error) => {
      assert.equal(JSON.parse(error.stdout).error.details.reason, 'daemon-owner-embedded');
      return true;
    },
  );
  assert.deepEqual(await a.client.sessions.list(), []);
  const [first, second] = await Promise.all([a.close(), a.close()]);
  assert.strictEqual(first, second);
  assert.deepEqual(first.requests, { drained: 0, abandoned: 0 });
  assert.deepEqual(disposed, ['fixture-a:shutdown', 'fixture-a:dispose']);
  assert.deepEqual(await b.client.sessions.list(), []);
  const replacement = await startAgentDevice({
    stateDir: a.clientConfig.stateDir,
    host: { cwd, env: supplied.env },
  });
  try {
    await assert.rejects(
      createAgentDeviceClient(a.clientConfig).sessions.list(),
      (error) => error.details?.reason === 'daemon-binding-mismatch',
    );
    const wrongToken = createAgentDeviceClient({
      ...replacement.clientConfig,
      daemonBinding: { ...replacement.clientConfig.daemonBinding, token: 'wrong-token' },
    });
    await assert.rejects(
      wrongToken.sessions.list(),
      (error) => error.details?.reason === 'daemon-binding-mismatch',
    );
  } finally {
    await replacement.close();
  }
  console.log(
    JSON.stringify({
      attachedFromChild: true,
      cleanRefused: true,
      externalStopRefused: true,
      siblingPreserved: true,
      replacementRefused: true,
      report: first,
    }),
  );
} finally {
  await a.close();
  await b.close();
}
assert.deepEqual(disposed, [
  'fixture-a:shutdown',
  'fixture-a:dispose',
  'fixture-b:shutdown',
  'fixture-b:dispose',
]);
assert.equal(fs.existsSync(path.join(cwd, 'host-a', 'daemon.json')), false);

`,
        ],
        { cwd: consumerRoot },
      ),
    );
    assert.equal(hosted.attachedFromChild, true);
    assert.equal(hosted.replacementRefused, true);
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
      const entries = ['agent-device', 'agent-device/contracts', 'agent-device/selectors', 'agent-device/plugins'];
      const exports = await Promise.all(entries.map(async (entry) => Object.keys(await import(entry)).sort()));
      const removed = ['ai-sdk', 'android-adb', 'artifacts', 'batch', 'finders', 'install-source', 'io', 'metro', 'remote-config'];
      const denied = await Promise.all(removed.map(async (entry) => {
        try { await import('agent-device/' + entry); return false; }
        catch (error) { return error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED'; }
      }));
      console.log(JSON.stringify({ exports, denied }));
    `,
    );
    assert.deepEqual(imports.exports, [
      [
        'AppError',
        'createAgentDeviceClient',
        'ensureDaemon',
        'isAgentDeviceError',
        'normalizeAgentDeviceError',
      ],
      ['defaultHintForCode'],
      ['listSelectorChainMatches', 'parseSelectorChain'],
      [],
    ]);
    assert.ok(imports.denied.every(Boolean));
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
