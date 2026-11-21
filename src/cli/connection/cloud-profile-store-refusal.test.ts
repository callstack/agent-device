import { afterEach, beforeEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { runCliCapture } from '../../__tests__/cli-capture.ts';
import { parseJsonOutputs } from '../../__tests__/test-utils/cli-json-outputs.ts';
import { resolveCliSessionPath } from '../auth-session.ts';

// Limrun answers no case here as an installed plugin. Each case makes the plugin store refuse the
// provider, or select a Limrun package that cannot load, so the control plane's
// `leaseProvider: "limrun"` is refused when the cloud route admits it — after the login was approved.
const CLOUD = 'https://cloud.example';
const LIMRUN_PACKAGE = '@agent-device/limrun';
const terminals = [process.stdin, process.stdout] as const;
const originalTty = terminals.map((stream) => Object.getOwnPropertyDescriptor(stream, 'isTTY'));

beforeEach(() => {
  for (const stream of terminals) {
    Object.defineProperty(stream, 'isTTY', { value: true, configurable: true });
  }
});

afterEach(() => {
  terminals.forEach((stream, index) => {
    const descriptor = originalTty[index];
    if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor);
    else delete (stream as { isTTY?: boolean }).isTTY;
  });
  vi.unstubAllGlobals();
});

/** The control plane: an approved device login, then a connection profile naming Limrun. */
function stubControlPlaneNamingLimrun(): void {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const { pathname } = new URL(String(input));
      if (pathname === '/api/control-plane/device-auth/start') {
        return json({ deviceCode: 'device', userCode: 'USER', verificationUri: `${CLOUD}/verify` });
      }
      if (pathname === '/api/control-plane/device-auth/poll') {
        return json({
          status: 'approved',
          accessToken: 'adc_agent_login',
          cliSession: { id: 'cli-1', refreshCredential: 'refresh-1' },
        });
      }
      if (pathname === '/api/control-plane/connection-profile') {
        return json({
          ok: true,
          connection: {
            remoteConfigProfile: {
              daemonBaseUrl: 'https://bridge.example.com/agent-device',
              tenant: 'acme',
              runId: 'run-1',
              leaseProvider: 'limrun',
            },
          },
        });
      }
      throw new Error(`unexpected request: ${pathname}`);
    }),
  );
}

/** The user config the plugin store cannot read, which the CLI flag reader ignores. */
function writeUnreadablePluginStore(pluginHome: string): void {
  fs.writeFileSync(path.join(pluginHome, 'config.json'), JSON.stringify({ plugins: [] }));
}

/** A Limrun selection whose entry throws as the store loads it. */
function selectUnusableLimrunPackage(pluginHome: string): void {
  const installation = '11111111-1111-4111-8111-111111111111';
  const directory = path.join(pluginHome, 'plugins', installation, 'node_modules', LIMRUN_PACKAGE);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(
    path.join(directory, 'package.json'),
    JSON.stringify({
      name: LIMRUN_PACKAGE,
      version: '2.0.0',
      type: 'module',
      engines: { node: '>=22.12' },
      'agent-device': { apiVersion: 3, provider: 'limrun' },
      exports: { './agent-device': { import: './plugin.mjs' } },
    }),
  );
  fs.writeFileSync(path.join(directory, 'plugin.mjs'), 'throw new Error("Limrun is not ready.");');
  fs.writeFileSync(
    path.join(pluginHome, 'config.json'),
    JSON.stringify({ plugins: { [LIMRUN_PACKAGE]: { installation } } }),
  );
}

const CLOUD_ROUTES = [
  { route: 'connect cloud', argv: ['cloud'] },
  { route: 'plain connect', argv: [] },
  {
    route: 'connect --daemon-base-url, where the generic auth step logs in',
    argv: ['--daemon-base-url', 'https://bridge.agent-device.dev/api', '--tenant', 'acme'],
  },
];

async function connectOnCloudRoute(argv: string[], preparePluginHome: (home: string) => void) {
  const { root, home, project } = makeTempWorkspace();
  const pluginHome = path.join(root, 'plugin-home');
  fs.mkdirSync(pluginHome, { recursive: true });
  preparePluginHome(pluginHome);
  const stateDir = path.join(root, 'state');
  const result = await runCliCapture(
    ['connect', ...argv, '--session', 'ci', '--state-dir', stateDir, '--json'],
    {
      cwd: project,
      env: {
        HOME: home,
        AGENT_DEVICE_HOME: pluginHome,
        AGENT_DEVICE_CLOUD_BASE_URL: CLOUD,
        // A remote shell prints the verification URL and opens no browser.
        SSH_TTY: '/dev/ttys001',
        CI: '',
        GITHUB_ACTIONS: '',
        BUILDKITE: '',
      },
    },
  );
  return { root, stateDir, result };
}

/** The one JSON result the run printed, as a provider-plugin refusal. */
function refusalDetails(
  stdout: string,
  reason: string,
): {
  package?: string;
  failedPlugins: Array<{ error?: { message?: string } }>;
} {
  const outputs = parseJsonOutputs(stdout);
  assert.equal(outputs.length, 1, stdout);
  const { error } = outputs[0] as {
    error: { code: string; details: Record<string, never> };
  };
  assert.equal(error.code, 'UNSUPPORTED_OPERATION');
  assert.equal(error.details.reason, reason);
  return error.details as unknown as {
    package?: string;
    failedPlugins: Array<{ error?: { message?: string } }>;
  };
}

/** The refused route wrote nothing: no CLI session, no `auth` directory, no connection state. */
function assertKeptNoConnectionOrAuthState(stateDir: string): void {
  assert.equal(fs.existsSync(resolveCliSessionPath(stateDir)), false, 'auth/cli-session.json');
  assert.equal(fs.existsSync(path.join(stateDir, 'auth')), false, 'auth directory');
  assert.equal(
    fs.existsSync(path.join(stateDir, 'remote-connections')),
    false,
    'remote-connections directory',
  );
}

test.each(CLOUD_ROUTES)(
  '$route with an unreadable plugin store discards the login Limrun discovery refused',
  async ({ argv }) => {
    stubControlPlaneNamingLimrun();
    const { root, stateDir, result } = await connectOnCloudRoute(argv, writeUnreadablePluginStore);

    assert.equal(result.code, 1, result.stdout + result.stderr);
    const details = refusalDetails(result.stdout, 'plugin-unavailable');
    // The store's own repair instruction, kept over the generic install guidance.
    assert.ok(details.failedPlugins.length > 0, result.stdout);
    assert.match(String(details.failedPlugins[0]?.error?.message), /Plugin config/);
    assertKeptNoConnectionOrAuthState(stateDir);
    fs.rmSync(root, { recursive: true, force: true });
  },
);

test.each(CLOUD_ROUTES)(
  '$route with a Limrun package that fails to load discards the refused login',
  async ({ argv }) => {
    stubControlPlaneNamingLimrun();
    const { root, stateDir, result } = await connectOnCloudRoute(argv, selectUnusableLimrunPackage);

    assert.equal(result.code, 1, result.stdout + result.stderr);
    const details = refusalDetails(result.stdout, 'plugin-unavailable');
    assert.equal(details.package, LIMRUN_PACKAGE);
    assertKeptNoConnectionOrAuthState(stateDir);
    fs.rmSync(root, { recursive: true, force: true });
  },
);
