import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { formatResultDebug, runBuiltCliJson } from './cli-json.ts';
import './support/provider-disconnect-fetch.mjs';

test('built CLI provider flow closes active generated session before disconnect cleanup', async (t) => {
  const fixture = createProviderDaemonFixture(t);
  const env = createProviderEnv(fixture);
  const activeSession = await connectBrowserStackProvider(fixture, env);
  await openProviderApp(fixture, env);
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
  return {
    ...process.env,
    BROWSERSTACK_USERNAME: 'browser-user',
    BROWSERSTACK_ACCESS_KEY: 'browser-key',
    AGENT_DEVICE_TEST_RPC_LOG_PATH: fixture.rpcLogPath,
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

async function connectBrowserStackProvider(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
): Promise<string> {
  const connectArgs = [
    'connect',
    'browserstack',
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
  const connectResult = await runBuiltCliJson(connectArgs, env);

  assert.equal(connectResult.status, 0, formatResultDebug('connect', connectArgs, connectResult));
  assert.equal(
    connectResult.json?.success,
    true,
    formatResultDebug('connect', connectArgs, connectResult),
  );
  const activeSession = connectResult.json?.data?.session;
  assert.match(activeSession, /^adc-/);
  return activeSession;
}

async function openProviderApp(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const openArgs = ['open', 'Demo', '--state-dir', fixture.stateDir, '--json'];
  const openResult = await runBuiltCliJson(openArgs, env);
  assert.equal(openResult.status, 0, formatResultDebug('open', openArgs, openResult));
  assert.equal(openResult.json?.success, true, formatResultDebug('open', openArgs, openResult));
}

async function disconnectProviderSession(
  fixture: ProviderDaemonFixture,
  env: NodeJS.ProcessEnv,
  activeSession: string,
): Promise<void> {
  const disconnectArgs = ['disconnect', '--state-dir', fixture.stateDir, '--json'];
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
  assert.equal(releaseRpc?.params?.leaseId, 'lease-bs-1');
  assert.equal(releaseRpc?.params?.leaseProvider, 'browserstack');
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
