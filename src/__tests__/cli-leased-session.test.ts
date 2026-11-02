import { test, vi } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { makeTempWorkspace } from '@agent-device/test-kit';
import { createAgentDeviceClient } from '@agent-device/client';
import type { DaemonResponse } from '@agent-device/daemon-client';
import {
  hashRemoteConfigFile,
  readRemoteConnectionState,
  writeRemoteConnectionState,
  type RemoteConnectionState,
} from '@agent-device/remote/remote-connection-state';
import { runCliCapture, type CapturedDaemonRequest } from './cli-capture.ts';
import { startPublicDaemonRuntime } from './test-utils/public-daemon-runtime.ts';

const profileResolutions = vi.hoisted(() => ({ count: 0 }));

vi.mock('@agent-device/remote/remote-config-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/remote/remote-config-core')>();
  return {
    ...actual,
    resolveRemoteConfigProfile: (...args: Parameters<typeof actual.resolveRemoteConfigProfile>) => {
      profileResolutions.count += 1;
      return actual.resolveRemoteConfigProfile(...args);
    },
  };
});

// Two agents on one machine share one state dir, and with it the machine-wide active-session pointer
// (#3931). Every command on a leased connection names its session explicitly.

const PROXY_URL = 'http://proxy.example.test/agent-device';

function scopeOf(req: CapturedDaemonRequest, key: string): unknown {
  return req.meta?.[key as keyof typeof req.meta] ?? req.flags?.[key as keyof typeof req.flags];
}

function leaseGateway(req: CapturedDaemonRequest): Promise<DaemonResponse> {
  if (req.command === 'lease_allocate' || req.command === 'lease_heartbeat') {
    const leaseProvider = scopeOf(req, 'leaseProvider');
    return Promise.resolve({
      ok: true,
      data: {
        lease: {
          leaseId: String(scopeOf(req, 'leaseId') ?? `lease-${String(scopeOf(req, 'runId'))}`),
          tenantId: scopeOf(req, 'tenantId') ?? scopeOf(req, 'tenant'),
          runId: scopeOf(req, 'runId'),
          backend: scopeOf(req, 'leaseBackend'),
          leaseProvider,
          clientId: scopeOf(req, 'clientId'),
          deviceKey:
            scopeOf(req, 'deviceKey') ??
            (leaseProvider === 'proxy' ? 'android:mobile:emulator-5554' : undefined),
        },
      },
    });
  }
  if (req.command === 'open') {
    return Promise.resolve({ ok: true, data: { session: req.session, appName: 'Example' } });
  }
  if (req.command === 'snapshot') {
    return Promise.resolve({ ok: true, data: { nodes: [], truncated: false } });
  }
  if (req.command === 'close') return Promise.resolve({ ok: true, data: {} });
  if (req.command === 'lease_release')
    return Promise.resolve({ ok: true, data: { released: true } });
  throw new Error(`unexpected daemon command: ${req.command}`);
}

type Workspace = { root: string; home: string; project: string; stateDir: string };

function workspace(): Workspace {
  const { root, home, project } = makeTempWorkspace();
  return { root, home, project, stateDir: path.join(root, 'state') };
}

async function runAgentCommand(
  workspace: Workspace,
  argv: string[],
  env: Record<string, string> = {},
) {
  return await runCliCapture([...argv, '--state-dir', workspace.stateDir, '--json'], {
    cwd: workspace.project,
    env: { HOME: workspace.home, ...env },
    sendToDaemon: leaseGateway,
  });
}

async function connectProxy(workspace: Workspace, session: string): Promise<void> {
  const result = await runAgentCommand(workspace, [
    'connect',
    'proxy',
    '--daemon-base-url',
    PROXY_URL,
    '--platform',
    'android',
    '--session',
    session,
  ]);
  assert.equal(result.code, null, result.stdout);
  assert.equal(JSON.parse(result.stdout).data.session, session);
}

function assertSessionRequired(result: Awaited<ReturnType<typeof runAgentCommand>>): void {
  assert.equal(result.code, 1);
  assert.deepEqual(result.calls, []);
  const error = JSON.parse(result.stdout).error;
  assert.equal(error.code, 'INVALID_ARGS');
  assert.equal(error.details.reason, 'REMOTE_SESSION_REQUIRED');
  assert.match(error.message, /--session/);
  assert.match(error.message, /AGENT_DEVICE_SESSION/);
}

function leaseIdOf(call: CapturedDaemonRequest | undefined): unknown {
  return call && scopeOf(call, 'leaseId');
}

function writeStoredConnection(
  workspace: Workspace,
  state: Pick<RemoteConnectionState, 'session' | 'tenant' | 'runId'> &
    Partial<RemoteConnectionState>,
): void {
  const remoteConfigPath = path.join(workspace.project, `${state.session}.remote.json`);
  fs.writeFileSync(remoteConfigPath, JSON.stringify({}));
  const now = new Date().toISOString();
  writeRemoteConnectionState({
    stateDir: workspace.stateDir,
    state: {
      version: 1,
      remoteConfigPath,
      remoteConfigHash: hashRemoteConfigFile(remoteConfigPath),
      connectedAt: now,
      updatedAt: now,
      ...state,
    },
  });
}

// The daemon reuses a lease for a matching run binding (tenant, run, backend, provider, device), so
// two sessions whose allocations would bind the same run end up sharing one lease.
async function leaseIdsOnRealDaemon(allocations: CapturedDaemonRequest[]): Promise<string[]> {
  const daemon = await startPublicDaemonRuntime({ serverMode: 'http' });
  try {
    const client = createAgentDeviceClient({
      daemonBaseUrl: daemon.baseUrl,
      daemonAuthToken: daemon.runtime.token,
      daemonTransport: 'http',
    });
    const leaseIds = [];
    for (const allocate of allocations) {
      const lease = await client.leases.allocate({
        tenant: String(scopeOf(allocate, 'tenantId')),
        runId: String(scopeOf(allocate, 'runId')),
        leaseBackend: 'android-instance',
        leaseProvider: 'proxy',
        clientId: String(scopeOf(allocate, 'clientId')),
      });
      leaseIds.push(lease.leaseId);
    }
    return leaseIds;
  } finally {
    await daemon.close();
  }
}

function allocationOf(result: Awaited<ReturnType<typeof runAgentCommand>>): CapturedDaemonRequest {
  const allocate = result.calls.find((call) => call.command === 'lease_allocate');
  assert.ok(allocate, result.stdout);
  return allocate;
}

test("a second agent on the same proxy never reaches the first agent's connection", async () => {
  const shared = workspace();
  await connectProxy(shared, 'agent-a');
  const openA = await runAgentCommand(shared, ['open', 'com.example', '--session', 'agent-a']);
  assert.equal(openA.code, null, openA.stdout);
  const leaseA = leaseIdOf(openA.calls.find((call) => call.command === 'open'));

  await connectProxy(shared, 'agent-b');
  const openB = await runAgentCommand(shared, ['open', 'com.example', '--session', 'agent-b']);
  assert.equal(openB.code, null, openB.stdout);
  const [leaseOfA, leaseOfB] = await leaseIdsOnRealDaemon([
    allocationOf(openA),
    allocationOf(openB),
  ]);
  assert.notEqual(leaseOfA, leaseOfB);

  // The pointer now names B's connection; a command that names no session must never reach it.
  const batchSteps = '[{"command":"snapshot","input":{}}]';
  for (const command of [
    ['snapshot'],
    ['batch', '--steps', batchSteps],
    ['close'],
    ['disconnect'],
  ]) {
    assertSessionRequired(await runAgentCommand(shared, command));
  }

  const byFlag = await runAgentCommand(shared, ['snapshot', '--session', 'agent-a']);
  assert.equal(byFlag.code, null, byFlag.stdout);
  assert.equal(leaseIdOf(byFlag.calls.at(-1)), leaseA);

  const byEnv = await runAgentCommand(shared, ['snapshot'], { AGENT_DEVICE_SESSION: 'agent-a' });
  assert.equal(byEnv.code, null, byEnv.stdout);
  assert.equal(leaseIdOf(byEnv.calls.at(-1)), leaseA);

  const close = await runAgentCommand(shared, ['close', '--session', 'agent-a']);
  assert.equal(close.code, null, close.stdout);
  const closeCall = close.calls.find((call) => call.command === 'close');
  assert.equal(closeCall?.session, 'agent-a');
  assert.equal(leaseIdOf(closeCall), leaseA);

  const disconnect = await runAgentCommand(shared, ['disconnect', '--session', 'agent-a']);
  assert.equal(disconnect.code, null, disconnect.stdout);
  assert.equal(readRemoteConnectionState({ stateDir: shared.stateDir, session: 'agent-a' }), null);
  assert.ok(readRemoteConnectionState({ stateDir: shared.stateDir, session: 'agent-b' }));

  fs.rmSync(shared.root, { recursive: true, force: true });
});

test('a leased connect or remote config is refused without a session before anything is leased', async () => {
  const solo = workspace();
  const remoteConfig = path.join(solo.project, 'proxy.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: PROXY_URL,
      tenant: 'proxy',
      runId: 'proxy-run',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      platform: 'android',
    }),
  );
  const batchSteps = '[{"command":"open","input":{"app":"com.example"}}]';

  for (const command of [
    ['connect', 'proxy', '--daemon-base-url', PROXY_URL, '--platform', 'android'],
    ['connect'],
    ['connect', '--remote-config', remoteConfig],
    ['open', 'com.example', '--remote-config', remoteConfig],
    ['batch', '--steps', batchSteps, '--remote-config', remoteConfig],
    ['close', '--remote-config', remoteConfig],
    ['disconnect', '--remote-config', remoteConfig],
    ['connection', 'status', '--remote-config', remoteConfig],
  ]) {
    assertSessionRequired(await runAgentCommand(solo, command));
  }
  assert.equal(fs.existsSync(path.join(solo.stateDir, 'remote-connections')), false);

  fs.rmSync(solo.root, { recursive: true, force: true });
});

test('a session-less command on a device-cloud connection is refused like one on a proxy', async () => {
  const shared = workspace();
  for (const session of ['limrun-a', 'limrun-b']) {
    writeStoredConnection(shared, {
      session,
      tenant: 'limrun',
      runId: `run-${session}`,
      leaseBackend: 'ios-instance',
      leaseProvider: 'limrun',
      platform: 'ios',
    });
  }

  assertSessionRequired(await runAgentCommand(shared, ['snapshot']));

  const named = await runAgentCommand(shared, ['snapshot', '--session', 'limrun-a']);
  assert.equal(named.code, null, named.stdout);
  assert.equal(named.calls.at(-1)?.command, 'snapshot');
  assert.equal(scopeOf(named.calls.at(-1)!, 'runId'), 'run-limrun-a');

  fs.rmSync(shared.root, { recursive: true, force: true });
});

test('a session named by flag, env or config never falls back onto the pointer', async () => {
  const shared = workspace();
  await connectProxy(shared, 'agent-a');
  writeStoredConnection(shared, {
    session: 'adc-generic',
    tenant: 'acme',
    runId: 'run-generic',
    leaseId: 'lease-generic',
    leaseBackend: 'android-instance',
    platform: 'android',
  });
  fs.writeFileSync(
    path.join(shared.project, 'agent-device.json'),
    JSON.stringify({ session: 'agent-config' }),
  );

  for (const [argv, env] of [
    [['snapshot', '--session', 'agent-flag'], {}],
    [['snapshot'], { AGENT_DEVICE_SESSION: 'agent-env' }],
    [['snapshot'], {}],
  ] as const) {
    const result = await runAgentCommand(shared, [...argv], env);
    assert.equal(result.code, null, result.stdout);
    assert.deepEqual(
      result.calls.map((call) => call.command),
      ['snapshot'],
    );
    assert.equal(scopeOf(result.calls[0]!, 'tenantId'), undefined);
    assert.equal(leaseIdOf(result.calls[0]), undefined);
  }

  fs.rmSync(shared.root, { recursive: true, force: true });
});

test('a macos-app remote config with a host-allocated lease needs a session and keeps its scope', async () => {
  const solo = workspace();
  const remoteConfig = path.join(solo.project, 'macos-app.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: PROXY_URL,
      tenant: 'host',
      runId: 'host-run',
      leaseId: 'abc123abc123abc1',
      leaseBackend: 'macos-app',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      deviceKey: 'com.example@4242',
      platform: 'macos',
    }),
  );
  assertSessionRequired(
    await runAgentCommand(solo, ['open', 'com.example', '--remote-config', remoteConfig]),
  );

  const open = await runAgentCommand(solo, [
    'open',
    'com.example',
    '--session',
    'agent-a',
    '--remote-config',
    remoteConfig,
  ]);
  assert.equal(open.code, null, open.stdout);
  const lease = open.calls.find((call) => call.command.startsWith('lease_'));
  assert.ok(lease, open.stdout);
  assert.equal(scopeOf(lease, 'runId'), 'host-run');
  assert.equal(scopeOf(lease, 'leaseId'), 'abc123abc123abc1');
  assert.equal(scopeOf(open.calls.at(-1)!, 'runId'), 'host-run');

  fs.rmSync(solo.root, { recursive: true, force: true });
});

function writeLeasedProfile(workspace: Workspace): string {
  const remoteConfig = path.join(workspace.project, 'shared.remote.json');
  fs.writeFileSync(
    remoteConfig,
    JSON.stringify({
      daemonBaseUrl: PROXY_URL,
      tenant: 'proxy',
      runId: 'proxy-run',
      leaseProvider: 'proxy',
      clientId: 'client-1',
      platform: 'android',
    }),
  );
  return remoteConfig;
}

test('sessions sharing one leased profile get leases of their own, and one session keeps its own', async () => {
  const shared = workspace();
  const remoteConfig = writeLeasedProfile(shared);
  const openA = await runAgentCommand(shared, [
    'open',
    'com.example',
    '--session',
    'agent-a',
    '--remote-config',
    remoteConfig,
  ]);
  assert.equal(openA.code, null, openA.stdout);
  const connectB = await runAgentCommand(shared, [
    'connect',
    '--remote-config',
    remoteConfig,
    '--session',
    'agent-b',
  ]);
  assert.equal(connectB.code, null, connectB.stdout);
  const openB = await runAgentCommand(shared, ['open', 'com.example', '--session', 'agent-b']);
  assert.equal(openB.code, null, openB.stdout);

  // The same session in a fresh state dir: its client and run come out the same.
  const fresh = { ...shared, stateDir: path.join(shared.root, 'fresh-state') };
  const openAAgain = await runAgentCommand(fresh, [
    'open',
    'com.example',
    '--session',
    'agent-a',
    '--remote-config',
    remoteConfig,
  ]);
  assert.equal(openAAgain.code, null, openAAgain.stdout);

  const [leaseA, leaseB, leaseAAgain] = await leaseIdsOnRealDaemon([
    allocationOf(openA),
    allocationOf(openB),
    allocationOf(openAAgain),
  ]);
  assert.notEqual(leaseA, leaseB);
  assert.equal(leaseAAgain, leaseA);

  fs.rmSync(shared.root, { recursive: true, force: true });
});

test('a refused leased remote config is resolved only once, by the parser', async () => {
  const solo = workspace();
  const remoteConfig = writeLeasedProfile(solo);
  profileResolutions.count = 0;

  assertSessionRequired(
    await runAgentCommand(solo, ['open', 'com.example', '--remote-config', remoteConfig]),
  );
  assert.ok(profileResolutions.count <= 1, `resolved ${profileResolutions.count} times`);

  fs.rmSync(solo.root, { recursive: true, force: true });
});

test('an unnamed disconnect on a non-leased remote config still uses the pointer', async () => {
  const solo = workspace();
  writeStoredConnection(solo, {
    session: 'adc-generic',
    tenant: 'acme',
    runId: 'run-generic',
    leaseBackend: 'android-instance',
    platform: 'android',
  });
  const remoteConfig = path.join(solo.project, 'adc-generic.remote.json');

  const disconnect = await runAgentCommand(solo, ['disconnect', '--remote-config', remoteConfig]);
  assert.equal(disconnect.code, null, disconnect.stdout);
  assert.equal(JSON.parse(disconnect.stdout).data.session, 'adc-generic');
  assert.equal(
    readRemoteConnectionState({ stateDir: solo.stateDir, session: 'adc-generic' }),
    null,
  );

  fs.rmSync(solo.root, { recursive: true, force: true });
});
