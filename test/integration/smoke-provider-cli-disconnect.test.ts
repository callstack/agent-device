import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { pluginHome, selectPlugin } from '@agent-device/test-kit';
import { formatResultDebug, runBuiltCliJson } from './cli-json.ts';
import './support/provider-disconnect-fetch.mjs';

const PROVIDER = 'smoke-cloud';

/**
 * A hosted provider arrives as an installed plugin, so this flow installs a minimal one: the point
 * is the built CLI's connect, open, and disconnect ordering, not a particular provider's API.
 */
const PROVIDER_PLUGIN_SOURCE = `export default () => ({
  apiVersion: 2,
  provider: ${JSON.stringify(PROVIDER)},
  credentials: { variables: [] },
  connection: {
    capabilities: {
      leaseKind: 'direct-device-provider',
      requiresAppAttachment: false,
      requiresRemoteDaemon: false,
      supportsArtifacts: true,
      supportsDeferredAppSelection: false,
      supportsDirectPortReverse: false,
      usesCloudWebDriverLease: true,
    },
    resolve: ({ flags }) => ({
      profile: {
        leaseProvider: ${JSON.stringify(PROVIDER)},
        platform: flags.platform,
        device: flags.device,
        providerOsVersion: flags.providerOsVersion,
        providerApp: flags.providerApp,
      },
    }),
    verify: async ({ flags }) => ({
      provider: ${JSON.stringify(PROVIDER)},
      service: 'Smoke Cloud',
      verificationMessage: 'Credentials, device, and uploaded app verified.',
      device: { status: 'verified', name: flags.device, platform: flags.platform, osVersion: flags.providerOsVersion },
      app: { status: 'verified', reference: flags.providerApp },
    }),
  },
  setup: async () => {
    throw new Error('The smoke daemon is remote and sets up no provider runtime.');
  },
});`;

test('built CLI provider flow closes its named session before disconnect cleanup', async (t) => {
  const fixture = createProviderDaemonFixture(t);
  const env = createProviderEnv(fixture);
  await assertUnnamedRefused(fixture, env, providerConnectArgs(fixture));
  const activeSession = await connectProvider(fixture, env);
  await assertUnnamedRefused(fixture, env, ['open', 'Demo']);
  await openProviderApp(fixture, env, activeSession);
  await disconnectProviderSession(fixture, env, activeSession);
  assertProviderDisconnectRpc(readRpcRequests(fixture), activeSession);
  await assertNoActiveConnection(fixture, env);
});

type ProviderDaemonFixture = {
  root: string;
  stateDir: string;
  daemonBaseUrl: string;
  rpcLogPath: string;
};

function createProviderDaemonFixture(t: TestContext): ProviderDaemonFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-provider-disconnect-smoke-'));
  const stateDir = path.join(root, 'state');
  const rpcLogPath = path.join(root, 'rpc.ndjson');
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    stateDir,
    daemonBaseUrl: 'https://agent-device.test/agent-device',
    rpcLogPath,
  };
}

function createProviderEnv(fixture: ProviderDaemonFixture): NodeJS.ProcessEnv {
  const fetchFixtureUrl = pathToFileURL(
    path.join(import.meta.dirname, 'support/provider-disconnect-fetch.mjs'),
  ).href;
  const { home, env: pluginEnv } = pluginHome();
  selectPlugin(home, '@agent-device/smoke-cloud', PROVIDER_PLUGIN_SOURCE);
  return {
    ...process.env,
    ...pluginEnv,
    AGENT_DEVICE_TEST_RPC_LOG_PATH: fixture.rpcLogPath,
    // Generated connection state never persists the daemon bearer token
    // (ADR 0007), so commands after `connect` must resolve it from the
    // environment/CLI chain, same as real usage.
    AGENT_DEVICE_DAEMON_AUTH_TOKEN: 'test-daemon-token',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, `--import=${fetchFixtureUrl}`]
      .filter(Boolean)
      .join(' '),
  };
}

function readRpcRequests(fixture: ProviderDaemonFixture): any[] {
  return fs
    .readFileSync(fixture.rpcLogPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function connectProvider(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const connectArgs = [...providerConnectArgs(fixture), '--session', 'provider-smoke'];
  const connectResult = await runBuiltCliJson(connectArgs, env);

  assert.equal(connectResult.status, 0, formatResultDebug('connect', connectArgs, connectResult));
  assert.equal(
    connectResult.json?.success,
    true,
    formatResultDebug('connect', connectArgs, connectResult),
  );
  const activeSession = connectResult.json?.data?.session;
  assert.equal(activeSession, 'provider-smoke');
  return activeSession;
}

function providerConnectArgs(fixture: ProviderDaemonFixture): string[] {
  return [
    'connect',
    PROVIDER,
    '--platform',
    'android',
    '--device',
    'Google Pixel 8',
    '--provider-os-version',
    '14.0',
    '--provider-app',
    'bs://app-id',
    '--daemon-base-url',
    fixture.daemonBaseUrl,
    '--daemon-auth-token',
    'test-daemon-token',
    '--state-dir',
    fixture.stateDir,
    '--json',
  ];
}

// A leased provider flow is refused at every step that names no session.
async function assertUnnamedRefused(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
  command: string[],
): Promise<void> {
  const args = command.includes('--state-dir')
    ? command
    : [...command, '--state-dir', fixture.stateDir, '--json'];
  const result = await runBuiltCliJson(args, env);
  assert.equal(result.status, 1, formatResultDebug(command[0] ?? '', args, result));
  assert.equal(
    result.json?.error?.details?.reason,
    'REMOTE_SESSION_REQUIRED',
    formatResultDebug(command[0] ?? '', args, result),
  );
}

async function openProviderApp(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
  session: string,
): Promise<void> {
  const openArgs = [
    'open',
    'Demo',
    '--session',
    session,
    '--state-dir',
    fixture.stateDir,
    '--json',
  ];
  const openResult = await runBuiltCliJson(openArgs, env);
  assert.equal(openResult.status, 0, formatResultDebug('open', openArgs, openResult));
  assert.equal(openResult.json?.success, true, formatResultDebug('open', openArgs, openResult));
}

async function disconnectProviderSession(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
  activeSession: string,
): Promise<void> {
  const disconnectArgs = [
    'disconnect',
    '--session',
    activeSession,
    '--state-dir',
    fixture.stateDir,
    '--json',
  ];
  const disconnectResult = await runBuiltCliJson(disconnectArgs, env);
  assert.equal(
    disconnectResult.status,
    0,
    formatResultDebug('disconnect', disconnectArgs, disconnectResult),
  );
  assert.equal(
    disconnectResult.json?.success,
    true,
    formatResultDebug('disconnect', disconnectArgs, disconnectResult),
  );
  assert.equal(disconnectResult.json?.data?.session, activeSession);
  assert.equal(disconnectResult.json?.data?.released, true);
}

function assertProviderDisconnectRpc(rpcRequests: any[], activeSession: string): void {
  const closeRpc = rpcRequests.find(
    (request) => request.method === 'agent_device.command' && request.params?.command === 'close',
  );
  assert.equal(closeRpc?.params?.session, activeSession);
  assert.notEqual(closeRpc?.params?.session, 'default');

  const releaseRpc = rpcRequests.find((request) => request.method === 'agent_device.lease.release');
  assert.equal(releaseRpc?.params?.session, activeSession);
  assert.equal(releaseRpc?.params?.leaseId, 'lease-smoke-1');
  assert.equal(releaseRpc?.params?.leaseProvider, PROVIDER);
}

async function assertNoActiveConnection(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const statusArgs = ['connection', 'status', '--state-dir', fixture.stateDir, '--json'];
  const statusResult = await runBuiltCliJson(statusArgs, env);
  assert.equal(statusResult.status, 0, formatResultDebug('status', statusArgs, statusResult));
  assert.equal(
    statusResult.json?.success,
    true,
    formatResultDebug('status', statusArgs, statusResult),
  );
  assert.equal(statusResult.json?.data?.connected, false);
}
