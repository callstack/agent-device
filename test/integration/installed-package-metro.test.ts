import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
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

/** A v2 plugin written against the packed `agent-device/plugins` types, type-checked as a consumer. */
async function typeCheckInstalledPluginContract(consumerRoot: string): Promise<void> {
  const source = path.join(consumerRoot, 'plugin-contract-smoke.ts');
  fs.writeFileSync(
    source,
    `import type { AgentDevicePluginFactory } from 'agent-device/plugins';
import { startAgentDevice, type AgentDeviceHost, type StartAgentDeviceOptions, type AgentDeviceClientConfig } from 'agent-device';

export async function hostConsumer(host: NonNullable<StartAgentDeviceOptions['host']>) {
  const options: StartAgentDeviceOptions = { stateDir: './state', host, plugins: [await example()] };
  const running: AgentDeviceHost = await startAgentDevice(options);
  const config: AgentDeviceClientConfig = running.clientConfig;
  void config;
  return await running.close();
}


type ExampleOptions = { credentials?: { username: string; accessKey: string } };

const example: AgentDevicePluginFactory<ExampleOptions> = (options = {}) => ({
  apiVersion: 2,
  provider: 'example',
  credentials: {
    variables: options.credentials ? [] : ['EXAMPLE_USERNAME', 'EXAMPLE_ACCESS_KEY'],
    byBackend: { 'android-instance': ['EXAMPLE_USERNAME'] },
  },
  setup: async (host) => ({
    runtime: { provider: 'example', shutdown: async () => {}, hostEnv: host.env },
    platformModule: {
      owner: { kind: 'provider-runtime', provider: 'example', instance: 'example' },
      loadRuntime: async () => ({}),
    },
  }),
});

export default example;
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

    const pluginTypes = fs.readFileSync(path.join(installedPackageRoot, 'dist/src/plugins.d.ts'));
    assert.ok(pluginTypes.length < 16 * 1024);
    const webDriverPluginTypes = fs.readFileSync(
      path.join(installedPackageRoot, 'dist/src/plugins/webdriver.d.ts'),
    );
    assert.ok(webDriverPluginTypes.length < 5120);
    for (const exported of [
      'AgentDevicePlugin',
      'AgentDevicePluginFactory',
      'PluginConnection',
      'PluginCredentials',
      'PluginSetupResult',
      'ProviderPluginHost',
    ]) {
      assert.match(
        pluginTypes.toString(),
        new RegExp(`export (?:type )?\\{[^}]*\\b${exported}\\b`),
      );
    }
    await typeCheckInstalledPluginContract(consumerRoot);
    fs.writeFileSync(
      path.join(consumerRoot, 'fixture-plugin.mjs'),
      String.raw`
export const disposed = [];
export const setups = [];
export function fixture(provider) {
  return {
    apiVersion: 2,
    provider,
    credentials: { variables: [] },
    setup: (host) => {
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
    },
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
import { createAgentDeviceClient } from 'agent-device';
import { startAgentDevice } from 'agent-device';

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
    fixture('limrun'),
    null,
    { ...fixture('wrong-version'), apiVersion: 1 },
    {
      ...fixture('broken'),
      setup() {
        throw new Error('fixture setup failure');
      },
    },
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
    inventory.filter((p) => p.provider === 'limrun' && p.source === 'embedder')[0].state,
    'failed',
  );
  assert.equal(inventory.find((p) => p.provider === 'broken').state, 'failed');
  assert.equal(inventory.find((p) => p.source === 'embedder' && p.provider === undefined).error.reason, 'invalid_plugin');
  assert.equal(inventory.find((p) => p.provider === 'wrong-version').error.reason, 'incompatible_plugin');
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
      "import { createAgentDeviceClient } from 'agent-device'; console.log(JSON.stringify(await createAgentDeviceClient(" + config + ").sessions.list()));",
    ],
    { cwd },
  );
  assert.deepEqual(JSON.parse(child.stdout), []);
  const cli = path.join(cwd, 'node_modules/agent-device/bin/agent-device.mjs');
  await assert.rejects(
    exec(
      process.execPath,
      [cli, 'daemon', 'stop', '--clean', '--state-dir', a.clientConfig.stateDir, '--json'],
      { cwd },
    ),
    (error) => {
      assert.equal(JSON.parse(error.stdout).error.details.reason, 'daemon-clean-not-detached');
      return true;
    },
  );
  assert.deepEqual(await a.client.sessions.list(), []);
  const stopped = await exec(
    process.execPath,
    [cli, 'daemon', 'stop', '--state-dir', a.clientConfig.stateDir, '--json'],
    { cwd },
  );
  assert.equal(JSON.parse(stopped.stdout).data.stopped, true);
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
      externalStop: true,
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
        import { readFileSync } from 'node:fs';
        import nodePath from 'node:path';
        import * as agentDeviceRoot from 'agent-device';
        import 'agent-device/contracts';
        import { createLocalArtifactAdapter as createIoArtifactAdapter } from 'agent-device/io';
        import { buildBundleUrl, normalizeBaseUrl } from 'agent-device/metro';
        const client = agentDeviceRoot.createAgentDeviceClient();
        const exportSubpaths = Object.keys(
          JSON.parse(
            readFileSync(
              nodePath.join(process.cwd(), 'node_modules', 'agent-device', 'package.json'),
              'utf8',
            ),
          ).exports,
        ).sort();
        const subpathSmoke = {
          '.': (mod) => mod.centerOfRect({ x: 0, y: 0, width: 10, height: 4 }),
          './ai-sdk': (mod) => typeof mod.createAgentDeviceTools,
          './android-adb': (mod) => {
            const manager = mod.createAndroidPortReverseManager(async () => ({
              stdout: '',
              stderr: '',
              exitCode: 0,
            }));
            return typeof manager.ensure;
          },
          './artifacts': async (mod) => {
            const name = await mod.resolveAndroidArchivePackageName(
              nodePath.join(process.cwd(), 'package.json'),
            );
            return String(name);
          },
          './batch': async (mod) => {
            const response = await mod.runBatch(
              { command: 'batch', positionals: [], flags: { batchOnError: 'continue' } },
              'smoke-session',
              async () => {
                throw new Error('batch invoke should not run');
              },
            );
            return response.ok === false ? response.error.code : 'unexpected-success';
          },
          './contracts': (mod) => mod.centerOfRect({ x: 2, y: 2, width: 6, height: 6 }),
          './finders': (mod) => mod.findBestMatchesByLocator([], 'text', 'anything').matches.length,
          './install-source': (mod) => typeof mod.isTrustedInstallSourceUrl('https://example.test/app.apk'),
          './io': (mod) => typeof mod.createLocalArtifactAdapter({ cwd: process.cwd() }).reserveOutput,
          './limrun': async (mod) => {
            const runtime = new mod.LimrunRuntime({ apiKey: 'lim_test_key' });
            await runtime.shutdown();
            return runtime.provider;
          },
          './metro': (mod) => mod.buildBundleUrl('https://public.example.test', 'ios'),
          './plugins': (mod) => Object.keys(mod).length === 0,
          './plugins/webdriver': (mod) => Object.keys(mod).length === 0,
          './remote-config': (mod) => typeof mod,
          './selectors': (mod) =>
            mod.isSelectorToken('||') &&
            typeof mod.parseSelectorChain === 'function' &&
            typeof mod.listSelectorChainMatches === 'function',
        };
        const subpathSmokeResults = {};
        for (const subpath of Object.keys(subpathSmoke).sort()) {
          const mod = await import('agent-device' + subpath.slice(1));
          subpathSmokeResults[subpath] = await subpathSmoke[subpath](mod);
        }
        const removedSubpaths = await Promise.all([
          'agent-device/host',
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
          exportSubpaths,
          smokedSubpaths: Object.keys(subpathSmoke).sort(),
          subpathSmokeResults,
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
      'ensureDaemon',
      'isAgentDeviceError',
      'isUnreadableCaptureContentError',
      'normalizeAgentDeviceError',
      'startAgentDevice',
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
    // Every subpath in the packed package's exports map must have a smoke check
    // above; adding a subpath without one fails here.
    assert.deepEqual(imports.smokedSubpaths, imports.exportSubpaths);
    assert.deepEqual(imports.subpathSmokeResults, {
      '.': { x: 5, y: 2 },
      './ai-sdk': 'function',
      './android-adb': 'function',
      './artifacts': 'undefined',
      './batch': 'INVALID_ARGS',
      './contracts': { x: 5, y: 5 },
      './finders': 0,
      './install-source': 'boolean',
      './io': 'function',
      './limrun': 'limrun',
      './plugins': true,
      './plugins/webdriver': true,
      // Type-only subpath: resolving the module from the packed exports map is
      // the entire runtime check.
      './remote-config': 'object',
      './metro': 'https://public.example.test/index.bundle?platform=ios&dev=true&minify=false',
      './selectors': true,
    });
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
