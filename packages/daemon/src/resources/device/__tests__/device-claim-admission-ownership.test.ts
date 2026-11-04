import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as fileHost from '@agent-device/host-kit/file';
import { createAndroidRuntimeModule } from '@agent-device/platform-android';
import {
  ANDROID_EMULATOR,
  createTestHostEnvironment,
  createUnavailableRuntimeFactsForTest,
} from '@agent-device/test-kit';
import {
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
} from '@agent-device/capture-kit';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { markScreenRecordingStartNotDispatched } from '@agent-device/contracts/screen-recording-runtime';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import { deviceIdentity } from '@agent-device/kernel/device';
import {
  acquireDeviceClaim,
  clearDeviceClaim,
  inspectDeviceClaims,
  reconcileOrphanedDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import {
  createOwnerScopedDeviceClaimReconciler,
  inspectDeviceClaimRecovery,
} from '@agent-device/daemon-contracts/device-claim-recovery';
import { SessionStore } from '../../../core/session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { createRequestExecutionScope } from '../../../server/request-execution-scope.ts';
import { handleRecordCommand } from '../../../sessions/handlers/record-runtime.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../../__tests__/support/device-claim-store.ts';
import { platformRequestScopeFixture } from '../../../__tests__/support/unavailable-device-runtime-gateway.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';

vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return {
    ...actual,
    classifyOwnerLiveness: (input: Parameters<typeof actual.classifyOwnerLiveness>[0]) =>
      input.owner.pid === 999999999
        ? ('owner-process-dead' as const)
        : actual.classifyOwnerLiveness(input),
    classifyOwnerLivenessFromObservation: (
      ...args: Parameters<typeof actual.classifyOwnerLivenessFromObservation>
    ) =>
      args[0].owner.pid === 999999999
        ? ('owner-process-dead' as const)
        : actual.classifyOwnerLivenessFromObservation(...args),
    readHostProcessIdentityObservations: (
      pids: Parameters<typeof actual.readHostProcessIdentityObservations>[0],
    ) => actual.readHostProcessIdentityObservations([...pids].filter((pid) => pid !== 999999999)),
  };
});

const setup = isolatedDeviceClaimStores('recording-owner-');
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const { root, stateDir, claimsDir } = setup();
  const workspace = path.join(root, 'worktree');
  const subdir = path.join(workspace, 'nested');
  const foreign = path.join(root, 'foreign');
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  fs.mkdirSync(subdir, { recursive: true });
  fs.mkdirSync(foreign, { recursive: true });
  const host = createTestHostEnvironment({ cwd: workspace, env: process.env });
  const store = new SessionStore(path.join(stateDir, 'sessions'), host);
  const registry = new LeaseRegistry();
  const scope = platformRequestScopeFixture();
  const device = ANDROID_EMULATOR;
  const owner = localRuntimeOwner('android');
  const output = path.join(stateDir, 'output.mp4');
  const handle = createScreenRecordingLiveHandle(
    {
      backend: 'fixture',
      outPath: output,
      startedAt: 1,
      scope: 'device',
      showTouches: false,
      recordOnlySession: true,
      gestureEvents: [],
    },
    {
      finish: async () => {
        fs.writeFileSync(output, 'video');
        return {
          status: 'completed' as const,
          result: {
            backend: 'fixture',
            outPath: output,
            startedAt: 1,
            completedAt: 2,
            scope: 'device' as const,
            showTouches: false,
            recordOnlySession: true,
          },
        };
      },
      forceCleanup: async () => ({ status: 'cleaned' as const }),
    },
  );
  const start = vi.fn(
    async (input: Parameters<PlatformRuntimeOperations['screenRecordingStart']>[0]) => ({
      pendingHandle: new PendingTransferGuard(handle),
      envelope: createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: input.sessionId,
        device: deviceIdentity(device),
        owner,
        fence: input.fence,
        lifecycle: 'open',
        descriptor: { version: 1, body: {} },
      }),
    }),
  );
  const reattach = vi.fn(async () => ({ status: 'missing' as const }));
  let startRecovery: 'confirmed-no-effect' | 'retained' = 'retained';
  const recoverIncompleteRecordingStart = vi.fn(async () => startRecovery);
  const factsBase = createUnavailableRuntimeFactsForTest(device, owner);
  const facts = {
    ...factsBase,
    operations: {
      ...factsBase.operations,
      screenRecordingStart: { available: true as const },
      screenRecordingReattach: { available: true as const },
      screenRecordingCleanup: { available: true as const },
    },
  };
  let gateway = {
    inspectFacts: async () => facts,
    bind: async () => ({
      device,
      owner,
      facts,
      recoverIncompleteRecordingStart,
      operations: {
        screenRecordingStart: start,
        screenRecordingReattach: reattach,
        screenRecordingCleanup: async () => ({ status: 'cleaned' as const }),
      },
      [Symbol.asyncDispose]: async () => {},
    }),
    shutdown: async () => {},
  } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
  async function scopeFor(
    command: string,
    action: string | undefined,
    cwd: string | undefined,
    state = store,
  ) {
    return await createRequestExecutionScope({
      host,
      req: {
        token: 't',
        session: 'recording',
        command,
        positionals: action ? [action] : [],
        flags: { recordingScope: 'device' },
        ...(cwd ? { meta: { cwd } } : {}),
      },
      sessionStore: state,
      leaseRegistry: registry,
      deviceRuntimeGateway: gateway,
      claimRecoveryGateway: () => gateway,
      platformServices: daemonPlatformServicesFixture(),
      platformRequestScope: scope,
    });
  }
  async function record(action: 'start' | 'stop', cwd: string | undefined, state = store) {
    const request = await scopeFor('record', action, cwd, state);
    const response = await request.runLocked(
      async () =>
        await handleRecordCommand({
          req: request.req,
          sessionName: request.sessionName,
          sessionStore: state,
          bindDevice: request.bindDevice,
          bindExactDevice: request.bindExactDevice,
          admissionLedger: createScreenRecordingAdmissionLedger(),
          requestScope: scope,
          platformServices: request.platformServices,
          retainDeviceExecutionLock: request.retainDeviceExecutionLock,
          throwIfCanceled: request.throwIfCanceled,
        }),
    );
    await request[Symbol.asyncDispose]();
    return response;
  }
  function publish(recordOnlySession: boolean) {
    return store.publish('recording', {
      name: 'recording',
      device,
      createdAt: 1,
      actions: [],
      recordOnlySession,
    });
  }
  const manifestPath = screenRecordingDurableResource.store.resolvePath(
    store.resolveSessionDir('recording'),
  );
  return {
    root,
    stateDir,
    claimsDir,
    workspace,
    subdir,
    foreign,
    host,
    store,
    scopeFor,
    record,
    publish,
    manifestPath,
    start,
    reattach,
    device,
    gateway,
    scope,
    recoverIncompleteRecordingStart,
    setGateway: (value: DeviceRuntimeGateway<PlatformRuntimeOperations>) => {
      gateway = value;
    },
    setStartRecovery: (value: 'confirmed-no-effect' | 'retained') => {
      startRecovery = value;
    },
  };
}

test('a record-only session keeps its exact claim for surviving app and audio owners', async () => {
  const f = fixture();
  const ref = f.publish(true);
  expect((await f.record('start', f.workspace)).ok).toBe(true);
  const claim = inspectDeviceClaims({}, process.env)[0]!.claim!;
  f.store.update(ref, { appBundleId: 'org.example.editor', audioProbe: {} as never });
  const own = await f.scopeFor('install', undefined, f.subdir);
  await own.bindDevice(f.device, { required: [], preferred: [] });
  await own[Symbol.asyncDispose]();
  const foreign = await f.scopeFor('install', undefined, f.foreign);
  await expect(foreign.bindDevice(f.device, { required: [], preferred: [] })).rejects.toMatchObject(
    { code: 'DEVICE_IN_USE' },
  );
  await foreign[Symbol.asyncDispose]();
  expect((await f.record('stop', f.subdir)).ok).toBe(true);
  expect(inspectDeviceClaims({}, process.env)[0]?.claim).toMatchObject({
    ownerToken: claim.ownerToken,
    claimOwnerKind: 'open-session',
  });
  const other = new SessionStore(path.join(f.root, 'other-state', 'sessions'), f.host);
  other.publish('recording', {
    name: 'recording',
    device: f.device,
    createdAt: 1,
    actions: [],
    recordOnlySession: true,
  });
  f.start.mockClear();
  expect(await f.record('start', f.workspace, other)).toMatchObject({
    ok: false,
    error: { code: 'DEVICE_IN_USE' },
  });
  expect(f.start).not.toHaveBeenCalled();
  expect(await clearDeviceClaim(f.store.requireCurrent(ref).deviceClaim, process.env)).toBe(
    'deleted',
  );
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
});

test('open-session recordings bind the claim token and reject a replacement before recovery', async () => {
  const f = fixture();
  f.publish(false);
  const acquired = await acquireDeviceClaim({
    device: f.device,
    session: 'recording',
    workspace: f.workspace,
    stateDir: f.stateDir,
    env: process.env,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  if (acquired.status !== 'acquired') throw new Error('claim not acquired');
  expect((await f.record('start', f.subdir)).ok).toBe(true);
  const record = screenRecordingDurableResource.store.read(f.manifestPath);
  expect(record).toMatchObject({
    status: 'decoded',
    envelope: {
      metadata: { deviceClaimToken: acquired.ownership.ownerToken, deviceClaimBindingVersion: 1 },
    },
  });
  const claimFile = path.join(
    f.claimsDir,
    fs.readdirSync(f.claimsDir).find((name) => name.endsWith('.json'))!,
  );
  const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
  fs.writeFileSync(claimFile, JSON.stringify({ ...claim, ownerToken: 'successor' }));
  expect(await f.record('stop', f.workspace)).toMatchObject({
    ok: false,
    error: { code: 'DEVICE_IN_USE' },
  });
  expect(f.reattach).not.toHaveBeenCalled();
  expect(inspectDeviceClaimRecovery({ ...claim, ownerToken: 'successor' })).toMatchObject({
    status: 'retained',
    reason: 'screen-recording-owner-mismatch',
  });
  expect(JSON.parse(fs.readFileSync(claimFile, 'utf8')).ownerToken).toBe('successor');
});

test('root and subdirectory share workspace authority while another worktree is refused', async () => {
  const f = fixture();
  f.publish(true);
  expect((await f.record('start', f.workspace)).ok).toBe(true);
  expect(await f.record('stop', f.foreign)).toMatchObject({
    ok: false,
    error: { code: 'DEVICE_IN_USE' },
  });
  expect((await f.record('stop', f.subdir)).ok).toBe(true);
});

test('an SDK request without cwd keeps the existing same-session coverage policy', async () => {
  const f = fixture();
  f.publish(true);
  expect((await f.record('start', f.workspace)).ok).toBe(true);
  expect((await f.record('stop', undefined)).ok).toBe(true);
});

test('a proven pre-dispatch failure releases the exact new reservation and leaves an older manifest untouched', async () => {
  const f = fixture();
  f.publish(true);
  const old = createDurableResourceEnvelope({
    resourceKind: 'screen-recording',
    sessionId: 'recording',
    device: deviceIdentity(f.device),
    owner: localRuntimeOwner('android'),
    fence: { token: 'old', generation: 2 },
    lifecycle: 'completed',
    descriptor: { version: 1, body: {} },
  });
  screenRecordingDurableResource.store.write(f.manifestPath, old);
  const before = fs.readFileSync(f.manifestPath, 'utf8');
  f.start.mockRejectedValueOnce(
    markScreenRecordingStartNotDispatched(new Error('output unavailable')),
  );
  expect((await f.record('start', f.workspace)).ok).toBe(false);
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
  expect(fs.readFileSync(f.manifestPath, 'utf8')).toBe(before);
});

test('an unknown start stays reserved until exact platform recovery proves no effect', async () => {
  const f = fixture();
  f.publish(true);
  f.start.mockRejectedValueOnce(new Error('launch outcome unknown'));
  expect((await f.record('start', f.workspace)).ok).toBe(false);
  const claim = inspectDeviceClaims({}, process.env)[0]!.claim!;
  expect(claim).toMatchObject({
    claimOwnerKind: 'transient-command',
    recordingRuntimeOwner: localRuntimeOwner('android'),
  });
  const refused = await f.record('stop', f.workspace);
  expect(refused).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'cleanup-unconfirmed' } },
  });
  expect(inspectDeviceClaims({}, process.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
  f.setStartRecovery('confirmed-no-effect');
  const settled = await f.record('stop', f.workspace);
  expect(settled).toMatchObject({
    ok: false,
    error: { code: 'INVALID_ARGS', details: { reason: 'recording-start-rolled-back' } },
  });
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
});

test('stale claim reconciliation leaves unknown native evidence and retires proven no-effect evidence', async () => {
  const f = fixture();
  f.publish(true);
  f.start.mockRejectedValueOnce(new Error('launch outcome unknown'));
  await f.record('start', f.workspace);
  const claimFile = path.join(
    f.claimsDir,
    fs.readdirSync(f.claimsDir).find((name) => name.endsWith('.json'))!,
  );
  const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
  fs.writeFileSync(
    claimFile,
    JSON.stringify({ ...claim, ownerPid: 999999999, ownerStartTime: 'dead' }),
  );
  const reconciler = createOwnerScopedDeviceClaimReconciler({
    scope: f.scope,
    composeGateway: () => f.gateway,
  });
  expect((await reconcileOrphanedDeviceClaims(reconciler, f.stateDir, process.env)).retained).toBe(
    1,
  );
  expect(fs.existsSync(claimFile)).toBe(true);
  f.setStartRecovery('confirmed-no-effect');
  expect(
    (await reconcileOrphanedDeviceClaims(reconciler, f.stateDir, process.env)).reconciled,
  ).toBe(1);
  expect(fs.existsSync(claimFile)).toBe(false);
});

test('confirmed adoption rollback releases the reservation when its tombstone cannot be written', async () => {
  const f = fixture();
  f.publish(true);
  const write = fileHost.publishDurableFileSync;
  vi.spyOn(fileHost, 'publishDurableFileSync').mockImplementation((input) => {
    if (input.destination === f.manifestPath) throw new Error('manifest write failed');
    return write(input);
  });
  const base = f.start.getMockImplementation()!;
  f.start.mockImplementationOnce(async (input) => {
    const started = await base(input);
    return { ...started, envelope: { ...started.envelope, sessionId: 'different-session' } };
  });
  const result = await f.record('start', f.workspace);
  expect(result.ok).toBe(false);
  expect(f.start).toHaveBeenCalledOnce();
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
  expect(fs.existsSync(f.manifestPath)).toBe(false);
});

test('Android incomplete-start recovery retains a writer and then clears only the exact no-effect marker', async () => {
  const f = fixture();
  f.publish(true);
  let marker = '';
  let writer = true;
  let allowMarkerRemoval = false;
  const stop = vi.fn(async () => 'stopped' as const);
  const transport = {
    mode: 'local' as const,
    start: async () => {
      throw new Error('launch outcome unknown');
    },
    inspect: async () => 'missing' as const,
    stop,
    exists: async () => false,
    size: async () => undefined,
    probeRunningWriters: async (remotePath: string) => ({
      conclusive: true,
      writers: writer ? [{ pid: '42', startTime: '1', remotePath }] : [],
    }),
    pullPlayable: async () => ({ stdout: '', stderr: '', exitCode: 0, playable: true }),
    remove: async () => true,
    manifestPathFor: (remotePath: string) =>
      `${remotePath.slice(0, remotePath.lastIndexOf('/'))}/agent-device-recording-active.json`,
    readManifest: async (markerPath: string) =>
      markerPath.startsWith('/sdcard') && marker
        ? { status: 'read' as const, contents: marker }
        : { status: 'missing' as const },
    writeManifest: async ({
      manifestPath,
      contents,
    }: {
      manifestPath: string;
      contents: string;
    }) => {
      if (manifestPath.startsWith('/sdcard')) marker = contents;
    },
    removeManifest: async () => {
      if (!allowMarkerRemoval) return false;
      marker = '';
      return true;
    },
  };
  const host = {
    hostEnvironment: f.host,
    androidTools: { probeClipboardShellSupport: async () => 'unsupported' },
    processTransports: { resolve: async () => ({}) },
    localInteractors: {
      resolve: async () => {
        throw new Error('unexpected interactor');
      },
    },
    audioProbe: { hostCapture: {} },
    screenRecording: {
      android: { resolve: async () => transport },
      outputs: {
        prepare: async () => {},
        inspect: async () => 'missing' as const,
        copy: async () => {},
        remove: async () => 'removed' as const,
      },
      finalize: { prepare: async () => {}, sniff: async () => {}, complete: async () => ({}) },
      ownedProcesses: { replace: () => {}, clear: () => {} },
    },
  } as unknown as PlatformRuntimeHost;
  const platform = await createAndroidRuntimeModule({ bindAdbHost: async () => {} }).loadRuntime(
    host,
  );
  f.setGateway({
    inspectFacts: platform.inspectFacts,
    bind: platform.bind,
    shutdown: async () => {},
  });
  expect((await f.record('start', f.workspace)).ok).toBe(false);
  const claim = inspectDeviceClaims({}, process.env)[0]!.claim!;
  expect(JSON.parse(marker).claimToken).toBe(claim.ownerToken);
  expect(await f.record('stop', f.workspace)).toMatchObject({
    ok: false,
    error: { details: { reason: 'cleanup-unconfirmed' } },
  });
  expect(marker).not.toBe('');
  expect(inspectDeviceClaims({}, process.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
  writer = false;
  allowMarkerRemoval = true;
  expect(await f.record('stop', f.workspace)).toMatchObject({
    ok: false,
    error: { details: { reason: 'recording-start-rolled-back' } },
  });
  expect(marker).toBe('');
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
  expect(stop).not.toHaveBeenCalled();
});
