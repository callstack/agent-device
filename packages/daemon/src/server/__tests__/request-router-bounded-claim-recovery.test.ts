import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { appLogResourceStore } from '@agent-device/capture-kit/app-log-durable-resource';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import {
  localRuntimeOwner,
  type DeviceBindingRequest,
} from '@agent-device/contracts/platform-runtime';
import { resolveDaemonPaths } from '@agent-device/daemon-contracts/daemon-resolution';
import {
  acquireDeviceClaim,
  canonicalLocalDeviceKey,
  inspectDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import { deviceIdentity, hostAppDevice, type DeviceInfo } from '@agent-device/kernel/device';
import type { DeviceInventoryRequest } from '@agent-device/contracts/device';
import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import {
  mkdtempForTestSync,
  createTestHostEnvironment,
  publishDaemonRegistration,
  withMockedPlatform,
} from '@agent-device/test-kit';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import {
  createRequestHandler,
  createLifecycleDeviceRuntimeGatewaySpies,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { unavailableDeviceRuntimeGateway } from '../../__tests__/support/unavailable-device-runtime-gateway.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import { replayScriptSourceBundleFor } from '../../__tests__/support/replay-script-source-fixture.ts';
import { readinessDeviceRuntimeGateway } from '../../__tests__/support/handlers/session-command-harness.ts';
import { makeAndroidDevice, makeIosDevice, openRequest } from './request-router-open-harness.ts';

const roots: string[] = [];
let oldClaimsDir: string | undefined;

beforeEach(() => {
  oldClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
});

afterEach(() => {
  if (oldClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
  else process.env.AGENT_DEVICE_CLAIMS_DIR = oldClaimsDir;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function root(prefix: string): string {
  const dir = mkdtempForTestSync(prefix);
  roots.push(dir);
  return dir;
}

function writeAppLog(device: DeviceInfo, stateDir: string): string {
  const resourcePath = appLogResourceStore.resolvePath(
    path.join(resolveDaemonPaths(stateDir).sessionsDir, 'foreign-session'),
  );
  appLogResourceStore.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'app-log',
      sessionId: 'foreign-session',
      device: deviceIdentity(device),
      owner: localRuntimeOwner(device.platform),
      fence: { token: 'log-fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { pid: 123 } },
    }),
  );
  return resourcePath;
}

function seedClaim(device: DeviceInfo, live = false, withResource = true) {
  const claimsDir = root('bounded-claim-files-');
  const stateDir = root('bounded-claim-owner-');
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  const deviceKey = canonicalLocalDeviceKey(deviceIdentity(device));
  const claimPath = path.join(
    claimsDir,
    `${crypto.createHash('sha256').update(deviceKey).digest('hex')}.json`,
  );
  const claim = {
    schemaVersion: 3,
    deviceKey,
    device: { ...deviceIdentity(device), name: device.name },
    session: 'foreign-session',
    workspace: '/worktrees/foreign',
    stateDir,
    ownerPid: live ? process.ppid : 999_999_999,
    ownerStartTime: live ? null : 'old-start-time',
    ownerToken: 'foreign-token',
    createdAtMs: 1,
    updatedAtMs: 1,
    claimOwnerKind: 'open-session',
  };
  fs.writeFileSync(claimPath, JSON.stringify(claim));
  if (live) publishDaemonRegistration(stateDir, { pid: process.ppid, startTime: null });
  const resourcePath = withResource ? writeAppLog(device, stateDir) : undefined;
  return { claimPath, resourcePath, stateDir };
}

function batchStep(
  command: string,
  flags: Record<string, unknown> = {},
  requestId = `bounded-${command}`,
) {
  return {
    ...openRequest('takeover', {}, requestId),
    command: 'batch',
    flags: { batchSteps: [{ command, flags }] },
  };
}

function route(
  device: DeviceInfo,
  options: {
    bootedAtMs?: number;
    power?: boolean;
    inventory?: DeviceInfo[] | ((request: Readonly<DeviceInventoryRequest>) => DeviceInfo[]);
    observeRunnerSession?: (
      deviceId: string,
    ) => Promise<{ alive: boolean; sessionId: string } | undefined>;
  } = {},
) {
  const baseGateway = options.power
    ? readinessDeviceRuntimeGateway
    : createLifecycleDeviceRuntimeGatewaySpies().gateway;
  const inspectFacts = vi.fn(
    async (selected: DeviceInfo) => await baseGateway.inspectFacts(selected),
  );
  const bind = vi.fn(async (request: DeviceBindingRequest) => await baseGateway.bind(request));
  const runtime = { inspectFacts, bind, gateway: { inspectFacts, bind, shutdown: async () => {} } };
  const recovery = vi.fn(() => unavailableDeviceRuntimeGateway);
  const leaseRegistry = new LeaseRegistry();
  const baseServices = daemonPlatformServicesFixture(
    options.bootedAtMs === undefined
      ? {}
      : {
          deviceBootObservation: {
            observeBootTimeMs: async () => ({
              observed: true as const,
              bootedAtMs: options.bootedAtMs!,
            }),
          },
        },
  );
  const services = options.observeRunnerSession
    ? daemonPlatformServicesFixture({
        ...baseServices,
        appleSessionObservation: {
          ...baseServices.appleSessionObservation,
          observeRunnerSession: options.observeRunnerSession,
        },
      })
    : baseServices;
  const sessionStore = makeSessionStore('bounded-claim-route-');
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    logPath: path.join(root('bounded-claim-log-'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry,
    deviceRuntimeGateway: runtime.gateway,
    claimRecoveryGateway: recovery,
    platformServices: services,
    deviceInventoryGateways: createTestDeviceInventoryGateways({
      local: async (request) =>
        typeof options.inventory === 'function'
          ? options.inventory(request)
          : (options.inventory ?? [device]),
    }),
    trackDownloadableArtifact: () => 'artifact-id',
  });
  return { handler, runtime, recovery, sessionStore };
}

function expectBoundedRecovery(
  response: Awaited<ReturnType<ReturnType<typeof route>['handler']>>,
  command: string,
) {
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'UNSUPPORTED_OPERATION',
      details: {
        reason: 'bounded_composite_resource_unsupported',
        shape: 'session-resource-recovery:app-log',
        standaloneCommandName: command,
        dispatched: 'no',
      },
    },
  });
}

test.each([
  { name: 'dead owner', live: false },
  { name: 'live owner after reboot', live: true },
])('bounded open refuses a $name before facts, binding and recovery', async ({ live }) => {
  const device = { ...makeIosDevice('SIM-BOUNDED-RECOVERY'), appleOs: 'ios' as const };
  const { claimPath, resourcePath } = seedClaim(device, live);
  const before = [fs.readFileSync(claimPath), fs.readFileSync(resourcePath!)];
  const { handler, runtime, recovery } = route(device, live ? { bootedAtMs: 2 } : {});
  const response = await handler(batchStep('open', { platform: 'ios' }));
  expectBoundedRecovery(response, 'open');
  expect(runtime.inspectFacts).not.toHaveBeenCalled();
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(recovery).not.toHaveBeenCalled();
  expect([fs.readFileSync(claimPath), fs.readFileSync(resourcePath!)]).toEqual(before);
});

test('bounded install_source refusal names public install-from-source', async () => {
  const command = 'install_source';
  const device = { ...makeIosDevice(`SIM-${command}-NAME`), appleOs: 'ios' as const };
  const { claimPath } = seedClaim(device, false);
  const before = fs.readFileSync(claimPath);
  const { handler, runtime, recovery } = route(device);
  const response = await handler(batchStep(command, { platform: 'ios' }));
  expectBoundedRecovery(response, 'install-from-source');
  expect(runtime.inspectFacts).not.toHaveBeenCalled();
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(recovery).not.toHaveBeenCalled();
  expect(fs.readFileSync(claimPath)).toEqual(before);
});

test('bounded install preserves the handler selector error before inventory resolution', async () => {
  const device = { ...makeIosDevice('SIM-NO-SELECTOR'), appleOs: 'ios' as const };
  const { handler, runtime, recovery } = route(device, { inventory: [] });
  const response = await handler(batchStep('install'));
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'INVALID_ARGS',
      details: { reason: 'session_or_device_selector_required', dispatched: 'no' },
    },
  });
  expect(runtime.inspectFacts).not.toHaveBeenCalled();
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(recovery).not.toHaveBeenCalled();
});

test('claim preview uses the request workspace to recognize its own exact claim', async () => {
  const device = { ...makeIosDevice('SIM-OWN-WORKSPACE'), appleOs: 'ios' as const };
  process.env.AGENT_DEVICE_CLAIMS_DIR = root('bounded-own-workspace-');
  const { handler, sessionStore } = route(device);
  const acquired = await acquireDeviceClaim({
    device,
    session: 'takeover',
    workspace: '/request/workspace',
    stateDir: sessionStore.resolveDaemonStateDir(),
    env: process.env,
    reconcileOrphanedDeviceClaim: async () => ({ status: 'retained', reason: 'test' }),
  });
  expect(acquired.status).toBe('acquired');
  const request = batchStep('open', { platform: 'ios' }, 'own-workspace-open');
  const response = await handler({
    ...request,
    meta: { ...request.meta, cwd: '/request/workspace' },
  });
  expect(response.ok, JSON.stringify(response)).toBe(true);
});

test('bounded reopen renews its own claim after the caller changes cwd', async () => {
  const device = { ...makeIosDevice('SIM-REOPEN-CWD'), appleOs: 'ios' as const };
  process.env.AGENT_DEVICE_CLAIMS_DIR = root('bounded-reopen-cwd-');
  const { handler } = route(device);
  expect(
    (
      await handler(
        openRequest('shared', { platform: 'ios' }, 'original-cwd', { cwd: '/tmp/ws-a' }, [
          'com.example.app',
        ]),
      )
    ).ok,
  ).toBe(true);
  const request = batchStep('open', {}, 'reopen-other-cwd');
  const response = await handler({
    ...request,
    session: 'shared',
    meta: { ...request.meta, cwd: '/tmp/ws-b' },
    flags: {
      batchSteps: [
        {
          command: 'open',
          positionals: ['com.example.app'],
          flags: { platform: 'ios', relaunch: true },
        },
      ],
    },
  });
  expect(response.ok, JSON.stringify(response)).toBe(true);
});

test('bounded open preserves in-daemon session conflict guidance', async () => {
  const device = { ...makeIosDevice('SIM-IN-DAEMON-CONFLICT'), appleOs: 'ios' as const };
  process.env.AGENT_DEVICE_CLAIMS_DIR = root('bounded-in-daemon-claims-');
  const { handler } = route(device);
  expect((await handler(openRequest('first', { platform: 'ios' }, 'first-open'))).ok).toBe(true);
  const direct = await handler(openRequest('second', { platform: 'ios' }, 'second-direct'));
  const bounded = await handler({
    ...batchStep('open', { platform: 'ios' }, 'third-bounded'),
    session: 'third',
  });
  expect(direct).toMatchObject({
    ok: false,
    error: { code: 'DEVICE_IN_USE', message: 'Device is already in use by session "first".' },
  });
  expect(bounded).toMatchObject({
    ok: false,
    error: {
      code: 'DEVICE_IN_USE',
      details: { session: 'first' },
    },
  });
  if (direct.ok || bounded.ok) throw new Error('Both opens must report the session conflict');
  expect(bounded.error.message).toContain(direct.error.message);
  expect(bounded.error.details?.hint).toBe(direct.error.details?.hint);
});

test('a completed owned manifest still refuses bounded recovery before cleanup', async () => {
  const device = { ...makeIosDevice('SIM-TERMINAL-MANIFEST'), appleOs: 'ios' as const };
  const { resourcePath } = seedClaim(device);
  const record = JSON.parse(fs.readFileSync(resourcePath!, 'utf8')) as Record<string, unknown>;
  fs.writeFileSync(resourcePath!, JSON.stringify({ ...record, lifecycle: 'completed' }));
  const before = fs.readFileSync(resourcePath!);
  const { handler, runtime, recovery } = route(device);
  expectBoundedRecovery(await handler(batchStep('open', { platform: 'ios' })), 'open');
  expect(runtime.inspectFacts).not.toHaveBeenCalled();
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(recovery).not.toHaveBeenCalled();
  expect(fs.readFileSync(resourcePath!)).toEqual(before);
});

test('a later mismatched manifest keeps the typed claim conflict', async () => {
  const device = { ...makeIosDevice('SIM-MIXED-MANIFESTS'), appleOs: 'ios' as const };
  const { stateDir, resourcePath } = seedClaim(device);
  const recordingPath = screenRecordingResourceStore.resolvePath(
    path.join(resolveDaemonPaths(stateDir).sessionsDir, 'foreign-session'),
  );
  screenRecordingResourceStore.write(
    recordingPath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: 'wrong-session',
      device: deviceIdentity(device),
      owner: localRuntimeOwner('apple'),
      fence: { token: 'record-fence', generation: 1 },
      lifecycle: 'open',
      descriptor: { version: 1, body: { recordingId: 'recording' } },
    }),
  );
  const before = [fs.readFileSync(resourcePath!), fs.readFileSync(recordingPath)];
  const { handler, runtime, recovery } = route(device);
  expect(await handler(batchStep('open', { platform: 'ios' }))).toMatchObject({
    ok: false,
    error: { code: 'DEVICE_IN_USE', details: { reason: 'DEVICE_CLAIM_RECOVERY_PENDING' } },
  });
  expect(runtime.inspectFacts).not.toHaveBeenCalled();
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(recovery).not.toHaveBeenCalled();
  expect([fs.readFileSync(resourcePath!), fs.readFileSync(recordingPath)]).toEqual(before);
});

test('replay preserves source and step identity for bounded claim recovery', async () => {
  const device = { ...makeIosDevice('SIM-REPLAY-CLAIM'), appleOs: 'ios' as const };
  const { resourcePath } = seedClaim(device);
  const before = fs.readFileSync(resourcePath!);
  const scriptDir = root('bounded-claim-replay-');
  const scriptPath = path.join(scriptDir, 'open.ad');
  fs.writeFileSync(scriptPath, 'open "com.example.editor"\n');
  const { handler, runtime, recovery } = route(device);
  const response = await handler({
    token: 'test-token',
    session: 'takeover',
    command: 'replay',
    positionals: [scriptPath],
    flags: { platform: 'ios', replayScriptSource: replayScriptSourceBundleFor(scriptPath) },
    meta: { cwd: scriptDir, requestId: 'bounded-replay-claim', sessionExplicit: true },
  });
  expect(response).toMatchObject({
    ok: false,
    error: {
      code: 'REPLAY_DIVERGENCE',
      details: {
        reason: 'bounded_composite_resource_unsupported',
        shape: 'session-resource-recovery:app-log',
        standaloneCommandName: 'open',
        dispatched: 'no',
        replayPath: scriptPath,
        step: 1,
      },
    },
  });
  expect(runtime.inspectFacts).not.toHaveBeenCalled();
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(recovery).not.toHaveBeenCalled();
  expect(fs.readFileSync(resourcePath!)).toEqual(before);
});

test('active-session replay install reaches its handler without a child scope lock', async () => {
  const device = { ...makeIosDevice('SIM-REPLAY-INSTALL-LOCK'), appleOs: 'ios' as const };
  const { handler, runtime, sessionStore } = route(device);
  sessionStore.publish('takeover', {
    name: 'takeover',
    device,
    appBundleId: 'com.example.app',
    createdAt: Date.now(),
    actions: [],
  });
  const scriptDir = root('bounded-replay-install-');
  const scriptPath = path.join(scriptDir, 'install.ad');
  const appPath = path.join(scriptDir, 'app.ipa');
  fs.writeFileSync(appPath, 'test artifact');
  fs.writeFileSync(scriptPath, `install com.example.app ${appPath}\n`);
  const response = await handler({
    token: 'test-token',
    session: 'takeover',
    command: 'replay',
    positionals: [scriptPath],
    flags: { replayScriptSource: replayScriptSourceBundleFor(scriptPath) },
    meta: { cwd: scriptDir, requestId: 'replay-install-lock', sessionExplicit: true },
  });
  if (!response.ok)
    expect(response.error.message).not.toContain('A device execution lock can only be retained');
  expect(runtime.inspectFacts).toHaveBeenCalled();
});

test('a bounded host open inspects a stale app claim and its resource', async () => {
  const host: DeviceInfo = {
    platform: 'apple',
    appleOs: 'macos',
    id: 'host-macos-local',
    name: 'Host Mac',
    kind: 'device',
    target: 'desktop',
    booted: true,
  };
  const app = hostAppDevice(host, 'com.example.editor');
  const { claimPath, resourcePath } = seedClaim(app);
  const before = [fs.readFileSync(claimPath), fs.readFileSync(resourcePath!)];
  const { handler, runtime, recovery } = route(host);
  expectBoundedRecovery(await handler(batchStep('open', { platform: 'macos' })), 'open');
  expect(runtime.inspectFacts).not.toHaveBeenCalled();
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(recovery).not.toHaveBeenCalled();
  expect([fs.readFileSync(claimPath), fs.readFileSync(resourcePath!)]).toEqual(before);
});

test('a bounded app open respects a live whole-Mac claim', async () => {
  const host: DeviceInfo = {
    platform: 'apple',
    appleOs: 'macos',
    id: 'host-macos-local',
    name: 'Host Mac',
    kind: 'device',
    target: 'desktop',
    booted: true,
  };
  const app = hostAppDevice(host, 'com.example.editor');
  const { claimPath } = seedClaim(host, true);
  const before = fs.readFileSync(claimPath);
  const { handler, runtime, recovery } = route(app);
  const response = await handler(batchStep('open', { platform: 'macos' }));
  expect(response).toMatchObject({
    ok: false,
    error: { code: 'DEVICE_IN_USE', details: { reason: 'DEVICE_CLAIM_LIVE_OWNER' } },
  });
  expect(runtime.inspectFacts).not.toHaveBeenCalled();
  expect(runtime.bind).not.toHaveBeenCalled();
  expect(recovery).not.toHaveBeenCalled();
  expect(fs.readFileSync(claimPath)).toEqual(before);
});

test.each(['owner-mismatch', 'unreadable-resource', 'unreadable-claim'] as const)(
  '%s retains typed ownership refusal without binding or recovery',
  async (condition) => {
    const device = { ...makeIosDevice(`SIM-${condition}`), appleOs: 'ios' as const };
    const { claimPath, resourcePath } = seedClaim(device);
    if (condition === 'owner-mismatch') {
      const record = JSON.parse(fs.readFileSync(resourcePath!, 'utf8')) as Record<string, unknown>;
      fs.writeFileSync(resourcePath!, JSON.stringify({ ...record, sessionId: 'other-session' }));
    } else if (condition === 'unreadable-resource') {
      fs.writeFileSync(resourcePath!, '{');
    } else {
      fs.writeFileSync(claimPath, '{');
    }
    const before = [fs.readFileSync(claimPath), fs.readFileSync(resourcePath!)];
    const { handler, runtime, recovery } = route(device);
    const response = await handler(batchStep('open', { platform: 'ios' }));
    expect(response).toMatchObject({
      ok: false,
      error: {
        code: 'DEVICE_IN_USE',
        details: {
          reason:
            condition === 'unreadable-claim'
              ? 'DEVICE_CLAIM_OWNER_UNCERTAIN'
              : 'DEVICE_CLAIM_RECOVERY_PENDING',
        },
      },
    });
    if (response.ok) throw new Error('expected a claim refusal');
    if (condition === 'unreadable-claim') expect(response.error.details?.owner).toBeUndefined();
    expect(runtime.inspectFacts).not.toHaveBeenCalled();
    expect(runtime.bind).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    expect([fs.readFileSync(claimPath), fs.readFileSync(resourcePath!)]).toEqual(before);
  },
);

test('Linux lock-policy strip reaches the bounded refusal on Android', async () => {
  await withMockedPlatform('linux', async () => {
    const device = makeAndroidDevice('emulator-claim-strip');
    const { resourcePath } = seedClaim(device);
    const before = fs.readFileSync(resourcePath!);
    const { handler, runtime, recovery } = route(device);
    const rejected = await handler({
      ...batchStep('open', { platform: 'android', target: 'desktop' }),
      meta: { requestId: 'bounded-open-reject', lockPolicy: 'reject', lockPlatform: 'android' },
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: 'INVALID_ARGS' } });
    const response = await handler({
      ...batchStep('open', { platform: 'android', target: 'desktop' }),
      meta: { requestId: 'bounded-open-strip', lockPolicy: 'strip', lockPlatform: 'android' },
    });
    expectBoundedRecovery(response, 'open');
    expect(runtime.inspectFacts).not.toHaveBeenCalled();
    expect(runtime.bind).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    expect(fs.readFileSync(resourcePath!)).toEqual(before);
  });
});

test('a re-resolved simulator claim refuses before runtime facts', async () => {
  await withMockedPlatform('darwin', async () => {
    const original = { ...makeIosDevice('SIM-STALE-ORIGINAL'), appleOs: 'ios' as const };
    const replacement = {
      ...makeIosDevice('SIM-ACTIVE-REPLACEMENT'),
      appleOs: 'ios' as const,
      name: original.name,
    };
    const { resourcePath } = seedClaim(original);
    const before = fs.readFileSync(resourcePath!);
    let inventory = [replacement];
    const { handler, runtime, recovery } = route(replacement, {
      power: true,
      observeRunnerSession: async () => undefined,
      inventory: () => inventory,
    });
    expect((await handler(openRequest('takeover', { platform: 'ios' }, 'replaced-open'))).ok).toBe(
      true,
    );
    runtime.inspectFacts.mockClear();
    runtime.bind.mockClear();
    inventory = [original];
    const response = await handler(batchStep('boot', { platform: 'ios' }, 'replaced-boot'));
    expectBoundedRecovery(response, 'boot');
    expect(runtime.inspectFacts).not.toHaveBeenCalled();
    expect(runtime.bind).not.toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    expect(fs.readFileSync(resourcePath!)).toEqual(before);
  });
});

test('a runner observation made during preview pins the selected simulator for the handler', async () => {
  await withMockedPlatform('darwin', async () => {
    const old = { ...makeIosDevice('SIM-RUNNER-OLD'), appleOs: 'ios' as const };
    const selected = { ...makeIosDevice('SIM-RUNNER-SELECTED'), appleOs: 'ios' as const };
    const { resourcePath } = seedClaim(old);
    const before = fs.readFileSync(resourcePath!);
    const observeRunnerSession = vi.fn(async () => ({ alive: true, sessionId: 'runner' }));
    let inventory = [selected];
    const { handler, runtime, recovery } = route(selected, {
      power: true,
      observeRunnerSession,
      inventory: () => inventory,
    });
    expect((await handler(openRequest('takeover', { platform: 'ios' }, 'runner-open'))).ok).toBe(
      true,
    );
    runtime.inspectFacts.mockClear();
    runtime.bind.mockClear();
    observeRunnerSession.mockClear();
    inventory = [old];
    const response = await handler(batchStep('boot', { platform: 'ios' }, 'runner-boot'));
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(observeRunnerSession).toHaveBeenCalledTimes(1);
    expect(runtime.inspectFacts.mock.calls.every(([device]) => device.id === selected.id)).toBe(
      true,
    );
    expect(runtime.bind.mock.calls.every(([request]) => request.device.id === selected.id)).toBe(
      true,
    );
    expect(recovery).not.toHaveBeenCalled();
    expect(fs.readFileSync(resourcePath!)).toEqual(before);
  });
});

test('bounded reopen leaves runner-observed device selection to the handler', async () => {
  await withMockedPlatform('darwin', async () => {
    const original = { ...makeIosDevice('SIM-REOPEN-ORIGINAL'), appleOs: 'ios' as const };
    const replacement = {
      ...makeIosDevice('SIM-REOPEN-REPLACEMENT'),
      appleOs: 'ios' as const,
      name: original.name,
    };
    let inventory = [original];
    const observeRunnerSession = vi.fn(
      async () => undefined as { alive: boolean; sessionId: string } | undefined,
    );
    const { handler, runtime } = route(original, {
      observeRunnerSession,
      inventory: () => inventory,
    });
    expect((await handler(openRequest('takeover', { platform: 'ios' }, 'reopen-first'))).ok).toBe(
      true,
    );
    runtime.bind.mockClear();
    inventory = [replacement];
    observeRunnerSession
      .mockResolvedValueOnce({ alive: true, sessionId: 'runner-original' })
      .mockResolvedValue(undefined);
    const response = await handler({
      ...batchStep('open', {}, 'reopen-bounded'),
      flags: {
        batchSteps: [
          {
            command: 'open',
            positionals: ['com.android.settings'],
            flags: { platform: 'ios', relaunch: true },
          },
        ],
      },
    });
    expect(response.ok, JSON.stringify(response)).toBe(true);
    expect(observeRunnerSession).toHaveBeenCalledOnce();
    expect(runtime.bind.mock.calls.every(([request]) => request.device.id === original.id)).toBe(
      true,
    );
  });
});

test.each([
  { command: 'open', flags: { platform: 'ios' } },
  { command: 'boot', flags: { platform: 'ios' } },
])(
  '$command recovery backstop refuses a resource that appears after preview',
  async ({ command, flags }) => {
    const device = { ...makeIosDevice(`SIM-${command}-RACE`), appleOs: 'ios' as const };
    const { claimPath, stateDir } = seedClaim(device, false, false);
    const { handler, runtime, recovery } = route(device, { power: command === 'boot' });
    const originalBind = runtime.bind.getMockImplementation()!;
    runtime.bind.mockImplementation(async (request) => {
      writeAppLog(device, stateDir);
      return await originalBind(request);
    });
    const response = await handler(batchStep(command, flags));
    expectBoundedRecovery(response, command);
    expect(runtime.bind).toHaveBeenCalled();
    expect(recovery).not.toHaveBeenCalled();
    expect(inspectDeviceClaims({ udid: device.id }, process.env)[0]?.claim?.session).toBe(
      'foreign-session',
    );
    expect(fs.existsSync(claimPath)).toBe(true);
  },
);

test('bounded fresh foreground open narrows a mixed inventory through the open owner', async () => {
  const ios = { ...makeIosDevice('SIM-FOREGROUND'), appleOs: 'ios' as const };
  const android = makeAndroidDevice('emulator-5554');
  const { handler, runtime } = route(ios, { inventory: [android, ios] });
  const response = await handler(batchStep('open', { foreground: true }));
  expect(response.ok).toBe(true);
  expect(runtime.inspectFacts).toHaveBeenCalled();
  expect(runtime.inspectFacts.mock.calls.every(([device]) => device.id === ios.id)).toBe(true);
  expect(runtime.bind.mock.calls.every(([request]) => request.device.id === ios.id)).toBe(true);
});

test.each(['boot', 'shutdown'] as const)(
  'bounded %s selects a stopped Android AVD',
  async (command) => {
    const avd = { ...makeAndroidDevice('Pixel_9'), name: 'Pixel_9', booted: false };
    const selections: string[] = [];
    const { handler, runtime } = route(avd, {
      power: true,
      inventory: (request) => {
        selections.push(request.androidAvdSelection ?? 'running-only');
        return request.androidAvdSelection === 'include-stopped' ? [avd] : [];
      },
    });
    const response = await handler(batchStep(command, { platform: 'android', device: 'Pixel_9' }));
    expect(response.ok).toBe(true);
    expect(selections).toContain('include-stopped');
    expect(runtime.inspectFacts.mock.calls.every(([device]) => device.id === avd.id)).toBe(true);
    expect(runtime.bind.mock.calls.every(([request]) => request.device.id === avd.id)).toBe(true);
  },
);

test('a later request does not inherit a prior request device pin', async () => {
  await withMockedPlatform('darwin', async () => {
    const original = { ...makeIosDevice('SIM-PIN-ORIGINAL'), appleOs: 'ios' as const };
    const replacement = {
      ...makeIosDevice('SIM-PIN-REPLACEMENT'),
      appleOs: 'ios' as const,
      name: original.name,
    };
    let inventory = [original];
    const { handler, runtime } = route(original, {
      power: true,
      observeRunnerSession: async () => undefined,
      inventory: () => inventory,
    });
    expect((await handler(openRequest('takeover', { platform: 'ios' }, 'pin-open'))).ok).toBe(true);
    runtime.bind.mockClear();
    inventory = [replacement];
    expect((await handler(batchStep('boot', { platform: 'ios' }, 'pin-first'))).ok).toBe(true);
    expect(runtime.bind.mock.calls.some(([request]) => request.device.id === replacement.id)).toBe(
      true,
    );
    runtime.bind.mockClear();
    inventory = [original];
    expect((await handler(batchStep('boot', { platform: 'ios' }, 'pin-second'))).ok).toBe(true);
    expect(runtime.bind.mock.calls.some(([request]) => request.device.id === original.id)).toBe(
      true,
    );
    expect(runtime.bind.mock.calls.some(([request]) => request.device.id === replacement.id)).toBe(
      false,
    );
  });
});
