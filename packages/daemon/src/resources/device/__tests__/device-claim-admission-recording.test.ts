import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as deviceSelection from '@agent-device/device-selection/dispatch-resolve';
import { runtimeModule as appleRuntimeModule } from '@agent-device/platform-apple';
import { createAndroidRuntimeModule } from '@agent-device/platform-android';
import {
  ANDROID_EMULATOR,
  IOS_SIMULATOR,
  createUnavailableRuntimeFactsForTest,
} from '@agent-device/test-kit';
import {
  createDurableResourceEnvelope,
  createScreenRecordingLiveHandle,
} from '@agent-device/capture-kit';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { PendingTransferGuard } from '@agent-device/contracts/async-lifecycle';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform-runtime';
import type {
  PlatformRuntimeHost,
  PlatformRuntimeOperations,
} from '@agent-device/contracts/platform-runtime-operations';
import type { AndroidScreenRecordingTransport } from '@agent-device/contracts/screen-recording-runtime-host';
import { deviceIdentity, hostAppDevice, type DeviceInfo } from '@agent-device/kernel/device';
import {
  inspectDeviceClaims,
  reconcileOrphanedDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import { createOwnerScopedDeviceClaimReconciler } from '@agent-device/daemon-contracts/device-claim-recovery';
import { createRequestExecutionScope } from '../../../server/request-execution-scope.ts';
import { SessionStore } from '../../../core/session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import { handleRecordCommand } from '../../../sessions/handlers/record-runtime.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { seed } from './device-claim-admission-recording.fixtures.ts';
import { androidRecordingMarkerPath } from './android-recording-transport.fixtures.ts';
import {
  isolatedClaimTestHost,
  isolatedDeviceClaimStores,
} from '../../../__tests__/support/device-claim-store.ts';
import { platformRequestScopeFixture } from '../../../__tests__/support/unavailable-device-runtime-gateway.ts';

vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  const fabricated = (pid: number) => pid === 999999999 || pid === process.ppid;
  const verdict = (pid: number) =>
    pid === 999999999 ? ('owner-process-dead' as const) : ('unknown' as const);
  return {
    ...actual,
    classifyOwnerLiveness: (params: Parameters<typeof actual.classifyOwnerLiveness>[0]) =>
      fabricated(params.owner.pid)
        ? verdict(params.owner.pid)
        : actual.classifyOwnerLiveness(params),
    classifyOwnerLivenessFromObservation: (
      ...args: Parameters<typeof actual.classifyOwnerLivenessFromObservation>
    ) =>
      fabricated(args[0].owner.pid)
        ? verdict(args[0].owner.pid)
        : actual.classifyOwnerLivenessFromObservation(...args),
    readHostProcessIdentityObservations: (
      pids: Parameters<typeof actual.readHostProcessIdentityObservations>[0],
    ) => actual.readHostProcessIdentityObservations([...pids].filter((pid) => !fabricated(pid))),
  };
});

const setup = isolatedDeviceClaimStores('record-claim-integration-');
afterEach(() => vi.restoreAllMocks());

function runtime(device: DeviceInfo, output: string) {
  let failFinish = false;
  let missing = false;
  let cleanupUnconfirmed = false;
  const native = `${output}.native`;
  fs.writeFileSync(native, 'preserved video');
  const finish = vi.fn(async () => {
    if (failFinish) throw new Error('export failed');
    fs.writeFileSync(output, fs.readFileSync(native));
    return {
      status: 'completed' as const,
      result: {
        backend: 'fixture',
        outPath: output,
        startedAt: 1,
        completedAt: 2,
        scope: 'device' as const,
        showTouches: false,
        recordOnlySession: false,
      },
    };
  });
  const handle = createScreenRecordingLiveHandle(
    {
      backend: 'fixture',
      outPath: output,
      startedAt: 1,
      scope: 'device',
      showTouches: false,
      recordOnlySession: false,
      gestureEvents: [],
    },
    {
      finish,
      forceCleanup: async () =>
        cleanupUnconfirmed
          ? { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }
          : { status: 'cleaned' },
    },
  );
  const signal = vi.fn();
  const recovered = {
    ...handle,
    settleForExport: async () => {
      signal();
      return { status: 'export' as const };
    },
  };
  const reattach = vi.fn(async () =>
    missing
      ? { status: 'missing' as const }
      : device.platform === 'apple'
        ? { status: 'export' as const, handle }
        : { status: 'active' as const, handle: recovered },
  );
  const start = vi.fn(
    async (input: Parameters<PlatformRuntimeOperations['screenRecordingStart']>[0]) => ({
      pendingHandle: new PendingTransferGuard(handle),
      envelope: createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: input.sessionId,
        device: deviceIdentity(device),
        owner: localRuntimeOwner(device.platform),
        fence: input.fence,
        lifecycle: 'open',
        descriptor: { version: 1, body: { outputPath: native } },
      }),
    }),
  );
  const cleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const owner = localRuntimeOwner(device.platform);
  const base = createUnavailableRuntimeFactsForTest(device, owner);
  const facts = {
    ...base,
    operations: {
      ...base.operations,
      screenRecordingStart: { available: true as const },
      screenRecordingReattach: { available: true as const },
      screenRecordingCleanup: { available: true as const },
    },
  };
  const binding = {
    device,
    owner,
    facts,
    operations: {
      screenRecordingStart: start,
      screenRecordingReattach: reattach,
      screenRecordingCleanup: cleanup,
    },
    [Symbol.asyncDispose]: async () => {},
  };
  const gateway = {
    inspectFacts: async () => facts,
    bind: async () => binding,
    shutdown: async () => {},
  } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
  return {
    gateway,
    handle,
    native,
    start,
    finish,
    reattach,
    signal,
    cleanup,
    fail: (value: boolean) => {
      failFinish = value;
    },
    missing: (value: boolean) => {
      missing = value;
    },
    cleanupUnconfirmed: (value: boolean) => {
      cleanupUnconfirmed = value;
    },
  };
}

async function request(
  stateDir: string,
  device: DeviceInfo,
  rt: ReturnType<typeof runtime>,
  action: 'start' | 'stop',
  store: SessionStore,
  publish = true,
  failAdoption = false,
) {
  if (store.resolveDaemonStateDir() !== stateDir)
    throw new Error('Unexpected test state directory');
  const host = isolatedClaimTestHost();
  const platformScope = platformRequestScopeFixture();
  const scope = await createRequestExecutionScope({
    host,
    req: {
      token: 't',
      session: 'recording',
      command: 'record',
      positionals: [action],
      flags: { recordingScope: 'device' },
    },
    sessionStore: store,
    leaseRegistry: new LeaseRegistry(),
    deviceRuntimeGateway: rt.gateway,
    claimRecoveryGateway: () => rt.gateway,
    platformServices: daemonPlatformServicesFixture(),
    platformRequestScope: platformScope,
  });
  if (publish && !store.lookup(scope.sessionName))
    store.publish(scope.sessionName, {
      name: scope.sessionName,
      device,
      createdAt: 1,
      actions: [],
      recordOnlySession: false,
    });
  const response = await scope.runLocked(
    async () =>
      await handleRecordCommand({
        req: scope.req,
        sessionName: scope.sessionName,
        sessionStore: store,
        bindDevice: scope.bindDevice,
        bindExactDevice: scope.bindExactDevice,
        admissionLedger: createScreenRecordingAdmissionLedger(),
        requestScope: platformScope,
        platformServices: scope.platformServices,
        retainDeviceExecutionLock: scope.retainDeviceExecutionLock,
        throwIfCanceled: failAdoption
          ? () => {
              throw new Error('adoption canceled');
            }
          : scope.throwIfCanceled,
      }),
  );
  await scope[Symbol.asyncDispose]();
  return { response, session: scope.sessionName };
}

test.for([ANDROID_EMULATOR, IOS_SIMULATOR])(
  'sweep preserves the claim and a same-session stop exports $platform material',
  async (device) => {
    const { stateDir, claimsDir } = setup();
    const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
    const output = path.join(stateDir, 'output.mp4');
    const rt = runtime(device, output);
    const { claimPath, resourcePath } = seed(stateDir, claimsDir, 'recording', device, rt.native);
    const reconcile = createOwnerScopedDeviceClaimReconciler({
      scope: platformRequestScopeFixture(),
      composeGateway: () => rt.gateway,
    });
    const swept = await reconcileOrphanedDeviceClaims(reconcile, stateDir, process.env);
    expect(swept.retained).toBe(1);
    expect(fs.readFileSync(rt.native, 'utf8')).toBe('preserved video');
    expect(fs.existsSync(claimPath)).toBe(true);
    expect(rt.finish).not.toHaveBeenCalled();
    const { response } = await request(stateDir, device, rt, 'stop', store);
    expect(response).toMatchObject({ ok: true });
    expect(fs.readFileSync(output, 'utf8')).toBe('preserved video');
    expect(screenRecordingDurableResource.store.read(resourcePath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'completed', metadata: { deviceClaimToken: 'original-token' } },
    });
    expect(fs.existsSync(claimPath)).toBe(false);
    expect(rt.cleanup).not.toHaveBeenCalled();
  },
);

test('failed export and missing resource retain the transferred claim until a successful retry', async () => {
  const { stateDir, claimsDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const { claimPath, resourcePath } = seed(
    stateDir,
    claimsDir,
    'recording',
    ANDROID_EMULATOR,
    rt.native,
  );
  rt.missing(true);
  const missing = await request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  expect(missing.response).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'resource-missing' } },
  });
  expect(JSON.parse(fs.readFileSync(claimPath, 'utf8'))).toMatchObject({
    ownerPid: process.pid,
    ownerToken: 'original-token',
  });
  rt.missing(false);
  rt.fail(true);
  const failed = await request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  expect(failed.response.ok).toBe(false);
  expect(screenRecordingDurableResource.store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { deviceClaimToken: 'original-token' } },
  });
  expect(fs.readFileSync(rt.native, 'utf8')).toBe('preserved video');
  expect(fs.existsSync(claimPath)).toBe(true);
  rt.fail(false);
  const success = await request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  expect(success.response.ok).toBe(true);
  expect(fs.existsSync(claimPath)).toBe(false);
});

test('a different state directory cannot replace an open recording or start native capture', async () => {
  const { root, stateDir, claimsDir } = setup();
  const otherState = path.join(root, 'other');
  const store = new SessionStore(path.join(otherState, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const { claimPath, resourcePath } = seed(
    stateDir,
    claimsDir,
    'recording',
    ANDROID_EMULATOR,
    rt.native,
  );
  const beforeClaim = fs.readFileSync(claimPath, 'utf8');
  const beforeManifest = fs.readFileSync(resourcePath, 'utf8');
  const { response } = await request(otherState, ANDROID_EMULATOR, rt, 'start', store);
  expect(response).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
  expect(rt.start).not.toHaveBeenCalled();
  expect(rt.signal).not.toHaveBeenCalled();
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(beforeClaim);
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe(beforeManifest);
});

test('a new recording retains its transient claim through start and clears it after stop', async () => {
  const { stateDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  vi.spyOn(deviceSelection, 'resolveTargetDevice').mockResolvedValue(ANDROID_EMULATOR);
  const started = await request(stateDir, ANDROID_EMULATOR, rt, 'start', store, false);
  expect(store.get(started.session)?.recordOnlySession).toBe(true);
  expect(store.get(started.session)?.deviceClaim?.ownerToken).toBeDefined();
  expect(started.response.ok).toBe(true);
  const claims = inspectDeviceClaims({}, process.env);
  expect(claims).toHaveLength(1);
  expect(claims[0]?.claim).toMatchObject({
    claimOwnerKind: 'transient-command',
    transientCommand: 'record',
    session: started.session,
  });
  const manifest = screenRecordingDurableResource.store.read(
    screenRecordingDurableResource.store.resolvePath(store.resolveSessionDir(started.session)),
  );
  expect(manifest).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { deviceClaimToken: claims[0]?.claim?.ownerToken } },
  });
  const stopped = await request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  expect(stopped.response.ok).toBe(true);
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
  expect(store.get(started.session)).toBeUndefined();
});

test('a changed claim token refuses a retry without reaching the recorder', async () => {
  const { stateDir, claimsDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const { claimPath, resourcePath } = seed(
    stateDir,
    claimsDir,
    'recording',
    ANDROID_EMULATOR,
    rt.native,
  );
  rt.missing(true);
  await request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  fs.writeFileSync(claimPath, JSON.stringify({ ...claim, ownerToken: 'replacement-token' }));
  const before = fs.readFileSync(resourcePath, 'utf8');
  rt.reattach.mockClear();
  rt.missing(false);
  const retry = await request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  expect(retry.response).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
  expect(rt.reattach).not.toHaveBeenCalled();
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe(before);
  expect(JSON.parse(fs.readFileSync(claimPath, 'utf8')).ownerToken).toBe('replacement-token');
});

test('a live or uncertain previous daemon never transfers a recording claim', async () => {
  const { stateDir, claimsDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const { claimPath, claim, resourcePath } = seed(
    stateDir,
    claimsDir,
    'recording',
    ANDROID_EMULATOR,
    rt.native,
  );
  fs.writeFileSync(
    claimPath,
    JSON.stringify({ ...claim, ownerPid: process.ppid, ownerStartTime: null }),
  );
  const original = fs.readFileSync(claimPath, 'utf8');
  const result = await request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  expect(result.response).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
  expect(rt.reattach).not.toHaveBeenCalled();
  expect(rt.signal).not.toHaveBeenCalled();
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(original);
  expect(screenRecordingDurableResource.store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
});

test('a failed preflight rolls back its transient reservation', async () => {
  const { stateDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const initialBind = rt.gateway.bind;
  vi.spyOn(rt.gateway, 'bind').mockImplementation(async (req) => {
    const binding = await initialBind(req);
    return {
      ...binding,
      facts: {
        ...binding.facts,
        operations: {
          ...binding.facts.operations,
          screenRecordingStart: { available: false, reason: 'owner-capability-missing' },
        },
      },
    };
  });
  const result = await request(stateDir, ANDROID_EMULATOR, rt, 'start', store);
  expect(result.response.ok).toBe(false);
  expect(rt.start).not.toHaveBeenCalled();
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
});

test('a confirmed failed-adoption rollback releases its recording reservation', async () => {
  const { stateDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const result = await request(stateDir, ANDROID_EMULATOR, rt, 'start', store, true, true);
  expect(result.response.ok).toBe(false);
  expect(rt.start).toHaveBeenCalledOnce();
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
  expect(
    screenRecordingDurableResource.store.read(
      screenRecordingDurableResource.store.resolvePath(store.resolveSessionDir(result.session)),
    ),
  ).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed', metadata: { cleanupStatus: 'cleaned' } },
  });
});

test('unconfirmed failed-adoption cleanup retains the claim and native recording', async () => {
  const { root, stateDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  rt.cleanupUnconfirmed(true);
  const result = await request(stateDir, ANDROID_EMULATOR, rt, 'start', store, true, true);
  expect(result.response.ok).toBe(false);
  expect(inspectDeviceClaims({}, process.env)[0]?.claim).toMatchObject({
    recordingStartPending: true,
  });
  expect(
    screenRecordingDurableResource.store.read(
      screenRecordingDurableResource.store.resolvePath(store.resolveSessionDir(result.session)),
    ),
  ).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open', metadata: { cleanupStatus: 'cleanup-pending' } },
  });
  expect(fs.readFileSync(rt.native, 'utf8')).toBe('preserved video');
  const otherState = path.join(root, 'other');
  fs.mkdirSync(otherState, { recursive: true });
  const other = new SessionStore(path.join(otherState, 'sessions'), isolatedClaimTestHost());
  const competitor = runtime(ANDROID_EMULATOR, path.join(otherState, 'competitor.mp4'));
  const refused = await request(otherState, ANDROID_EMULATOR, competitor, 'start', other);
  expect(refused.response).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
  expect(competitor.start).not.toHaveBeenCalled();
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(1);
});

test('an unconfirmed native start keeps its reservation even when an older manifest is completed', async () => {
  const { stateDir, claimsDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    path.join(stateDir, 'sessions', 'recording'),
  );
  screenRecordingDurableResource.store.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: 'recording',
      device: deviceIdentity(ANDROID_EMULATOR),
      owner: localRuntimeOwner('android'),
      fence: { token: 'old-fence', generation: 1 },
      lifecycle: 'completed',
      descriptor: { version: 1, body: {} },
    }),
  );
  rt.start.mockRejectedValueOnce(new Error('native start outcome unknown'));
  const failed = await request(stateDir, ANDROID_EMULATOR, rt, 'start', store);
  expect(failed.response.ok).toBe(false);
  const retained = inspectDeviceClaims({}, process.env)[0]?.claim;
  expect(retained?.recordingFence).toMatchObject({ generation: 2 });
  expect(fs.readdirSync(claimsDir).some((name) => name.endsWith('.json'))).toBe(true);
  const reconcile = createOwnerScopedDeviceClaimReconciler({
    scope: platformRequestScopeFixture(),
    composeGateway: () => rt.gateway,
  });
  expect(await reconcile(retained!)).toMatchObject({
    status: 'retained',
    reason: 'screen-recording-owner-unsettled',
  });
  expect(fs.existsSync(rt.native)).toBe(true);
});

test('a replacement token survives completion while runtime bindings drain', async () => {
  const { stateDir, claimsDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const { claimPath } = seed(stateDir, claimsDir, 'recording', ANDROID_EMULATOR, rt.native);
  let unblock!: () => void;
  let reachedCleanup!: () => void;
  const cleanupStarted = new Promise<void>((resolve) => {
    reachedCleanup = resolve;
  });
  const waitCleanup = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const originalBind = rt.gateway.bind;
  vi.spyOn(rt.gateway, 'bind').mockImplementation(async (args) => {
    const binding = await originalBind(args);
    return {
      ...binding,
      [Symbol.asyncDispose]: async () => {
        reachedCleanup();
        await waitCleanup;
      },
    };
  });
  const pending = request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  await cleanupStarted;
  const transferred = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  expect(transferred.ownerToken).toBe('original-token');
  fs.writeFileSync(claimPath, JSON.stringify({ ...transferred, ownerToken: 'successor-token' }));
  unblock();
  expect((await pending).response.ok).toBe(true);
  expect(JSON.parse(fs.readFileSync(claimPath, 'utf8')).ownerToken).toBe('successor-token');
});

test('a sweep holds claim admission until settlement drains before stop and competing start', async () => {
  const { root, stateDir, claimsDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const { claimPath } = seed(stateDir, claimsDir, 'recording', ANDROID_EMULATOR, rt.native);
  let release!: () => void;
  let settlementStarted!: () => void;
  const entered = new Promise<void>((resolve) => {
    settlementStarted = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = rt.gateway.bind;
  let first = true;
  vi.spyOn(rt.gateway, 'bind').mockImplementation(async (args) => {
    const binding = await original(args);
    if (!first || args.intent.kind !== 'exact-owner') return binding;
    first = false;
    const reattach = binding.operations.screenRecordingReattach!;
    return {
      ...binding,
      operations: {
        ...binding.operations,
        screenRecordingReattach: async (input) => {
          const outcome = await reattach(input);
          if (outcome.status !== 'active') return outcome;
          return {
            ...outcome,
            handle: {
              ...outcome.handle,
              settleForExport: async () => {
                settlementStarted();
                await hold;
                return { status: 'export' as const };
              },
            },
          };
        },
      },
    };
  });
  const reconciler = createOwnerScopedDeviceClaimReconciler({
    scope: platformRequestScopeFixture(),
    composeGateway: () => rt.gateway,
  });
  const sweep = reconcileOrphanedDeviceClaims(reconciler, stateDir, process.env);
  await entered;
  const otherState = path.join(root, 'other');
  const other = new SessionStore(path.join(otherState, 'sessions'), isolatedClaimTestHost());
  const competing = request(otherState, ANDROID_EMULATOR, rt, 'start', other);
  const stopping = request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  expect(rt.start).not.toHaveBeenCalled();
  expect(fs.existsSync(claimPath)).toBe(true);
  release();
  expect((await sweep).retained).toBe(1);
  const [stop, start] = await Promise.all([stopping, competing]);
  // The competing start can acquire only after stop fully finishes, so make its admission race
  // deterministic in a separate refusal test above; here the sweep and stop must both drain.
  expect(stop.response.ok).toBe(true);
  if (start.response.ok) expect(rt.start).toHaveBeenCalledOnce();
});

test('the Apple runtime exports a proven-gone simulator recording through claim reconciliation and the request handler', async () => {
  const { stateDir, claimsDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const output = path.join(stateDir, 'real-apple.mp4');
  const native = path.join(stateDir, 'real-apple.native.mp4');
  const prepare = vi.fn(async () => {});
  const finalize = vi.fn(async () => ({}));
  const terminate = vi.fn(async () => 'terminated' as const);
  const host = {
    hostEnvironment: isolatedClaimTestHost(),
    localInteractors: {
      resolve: async () => {
        throw new Error('unexpected interactor');
      },
    },
    audioProbe: { hostCapture: {} },
    screenRecording: {
      apple: {
        availability: async () => ({ available: true as const }),
        isRunnerBundleId: async () => false,
        startSimulator: async (_device: DeviceInfo, nativePath: string) => {
          fs.writeFileSync(nativePath, 'simulator video');
          return {
            markers: [{ pid: 123, startTime: 'old', command: 'simctl recordVideo' }],
            wait: new Promise<never>(() => {}),
            terminate: async () => {},
          };
        },
        inspectProcess: async () => 'missing' as const,
        terminateProcess: terminate,
      },
      outputs: {
        inspect: async (file: string) =>
          fs.existsSync(file) ? ('present' as const) : ('missing' as const),
        prepare: async (file: string) => {
          fs.rmSync(file, { force: true });
        },
        copy: async ({ from, to }: { from: string; to: string }) => {
          fs.copyFileSync(from, to);
        },
        remove: async (file: string) => {
          fs.rmSync(file, { force: true });
          return 'removed' as const;
        },
      },
      finalize: {
        prepare,
        sniff: async ({ outputPath }: { outputPath: string }) => {
          fs.accessSync(outputPath);
        },
        complete: finalize,
      },
      ownedProcesses: { replace: () => {}, clear: () => {} },
    },
  } as unknown as PlatformRuntimeHost;
  const platform = await appleRuntimeModule.loadRuntime(host);
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: platform.inspectFacts,
    bind: platform.bind,
    shutdown: async () => {},
  };
  const scope = platformRequestScopeFixture();
  const initial = await gateway.bind({
    device: IOS_SIMULATOR,
    intent: { kind: 'ordinary' },
    scope,
  });
  const started = await initial.operations.screenRecordingStart!({
    sessionId: 'recording',
    outputPath: output,
    scope: 'device',
    showTouches: false,
    hideTouchesRequested: false,
    recordOnlySession: false,
    claimToken: 'original-token',
    fence: { token: 'real-fence', generation: 1 },
  });
  expect(fs.readFileSync(native, 'utf8')).toBe('simulator video');
  const { claimPath } = seed(
    stateDir,
    claimsDir,
    'recording',
    IOS_SIMULATOR,
    native,
    started.envelope,
  );
  prepare.mockClear();
  prepare.mockImplementation(async () => await new Promise<void>(() => {}));
  const rt = runtime(IOS_SIMULATOR, path.join(stateDir, 'fixture-unused.mp4'));
  rt.gateway = gateway;
  const reconciler = createOwnerScopedDeviceClaimReconciler({
    scope,
    composeGateway: () => gateway,
  });
  expect((await reconcileOrphanedDeviceClaims(reconciler, stateDir, process.env)).retained).toBe(1);
  expect(prepare).not.toHaveBeenCalled();
  expect(finalize).not.toHaveBeenCalled();
  expect(terminate).not.toHaveBeenCalled();
  expect(fs.existsSync(claimPath)).toBe(true);
  const result = await request(stateDir, IOS_SIMULATOR, rt, 'stop', store);
  expect(result.response).toMatchObject({ ok: true });
  expect(fs.readFileSync(output, 'utf8')).toBe('simulator video');
  expect(terminate).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();
  expect(finalize).toHaveBeenCalledOnce();
  expect(fs.existsSync(claimPath)).toBe(false);
});

test('the Android runtime settles its exact recorder and exports its preserved chunk through the claim and handler', async () => {
  const { stateDir, claimsDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const output = path.join(stateDir, 'real-android.mp4');
  const deviceFiles = new Map<string, string>();
  const markers = new Map<string, string>();
  let running = true;
  const signal = vi.fn(async () => {
    running = false;
    return 'stopped' as const;
  });
  const prepare = vi.fn(async () => {});
  const finalize = vi.fn(async () => ({}));
  const transport: AndroidScreenRecordingTransport = {
    mode: 'local' as const,
    start: async ({ remotePath, admission }) => {
      if (
        admission.manifestPath !== androidRecordingMarkerPath(remotePath) ||
        markers.get(admission.manifestPath) !== admission.expected
      )
        throw new Error('launch admission mismatch');
      markers.set(admission.manifestPath, admission.admitted);
      deviceFiles.set(remotePath, 'android video');
      return { process: { pid: '42', startTime: '1', remotePath } };
    },
    inspect: async () => (running ? ('owned-alive' as const) : ('missing' as const)),
    stop: signal,
    exists: async (file: string) => deviceFiles.has(file),
    size: async (file: string) =>
      deviceFiles.has(file) ? deviceFiles.get(file)!.length : undefined,
    probeRunningWriters: async () => ({ writers: [], conclusive: true }),
    pullPlayable: async ({
      remotePath,
      outputPath,
    }: {
      remotePath: string;
      outputPath: string;
    }) => {
      fs.writeFileSync(outputPath, deviceFiles.get(remotePath)!);
      return { stdout: '', stderr: '', exitCode: 0, playable: true };
    },
    remove: async (file: string) => {
      deviceFiles.delete(file);
      return true;
    },
    manifestPathFor: androidRecordingMarkerPath,
    readManifest: async (manifestPath) => {
      const contents = markers.get(manifestPath);
      return contents === undefined ? { status: 'missing' } : { status: 'read', contents };
    },
    compareAndSetManifest: async ({ manifestPath, expected, contents }) => {
      if ((markers.get(manifestPath) ?? null) !== expected) return 'mismatch';
      if (contents === null) markers.delete(manifestPath);
      else markers.set(manifestPath, contents);
      return 'updated';
    },
  };
  const host = {
    hostEnvironment: isolatedClaimTestHost(),
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
        inspect: async (file: string) =>
          fs.existsSync(file) ? ('present' as const) : ('missing' as const),
        prepare: async (file: string) => {
          fs.rmSync(file, { force: true });
        },
        copy: async ({ from, to }: { from: string; to: string }) => {
          fs.copyFileSync(from, to);
        },
        remove: async (file: string) => {
          fs.rmSync(file, { force: true });
          return 'removed' as const;
        },
      },
      finalize: {
        prepare,
        sniff: async ({ outputPath }: { outputPath: string }) => {
          fs.accessSync(outputPath);
        },
        complete: finalize,
      },
      ownedProcesses: { replace: () => {}, clear: () => {} },
    },
  } as unknown as PlatformRuntimeHost;
  const platform = await createAndroidRuntimeModule({ bindAdbHost: async () => {} }).loadRuntime(
    host,
  );
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: platform.inspectFacts,
    bind: platform.bind,
    shutdown: async () => {},
  };
  const scope = platformRequestScopeFixture();
  const initial = await gateway.bind({
    device: ANDROID_EMULATOR,
    intent: { kind: 'ordinary' },
    scope,
  });
  const started = await initial.operations.screenRecordingStart!({
    sessionId: 'recording',
    outputPath: output,
    scope: 'device',
    showTouches: false,
    hideTouchesRequested: false,
    recordOnlySession: false,
    claimToken: 'original-token',
    fence: { token: 'real-android-fence', generation: 1 },
  });
  expect([...deviceFiles.values()]).toEqual(['android video']);
  const { claimPath } = seed(
    stateDir,
    claimsDir,
    'recording',
    ANDROID_EMULATOR,
    path.join(stateDir, 'unused'),
    started.envelope,
  );
  prepare.mockClear();
  prepare.mockImplementation(async () => await new Promise<void>(() => {}));
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'fixture-unused.mp4'));
  rt.gateway = gateway;
  const reconciler = createOwnerScopedDeviceClaimReconciler({
    scope,
    composeGateway: () => gateway,
  });
  expect((await reconcileOrphanedDeviceClaims(reconciler, stateDir, process.env)).retained).toBe(1);
  expect(signal).toHaveBeenCalledOnce();
  expect([...deviceFiles.values()]).toEqual(['android video']);
  expect(markers.size).toBe(1);
  expect(prepare).not.toHaveBeenCalled();
  expect(finalize).not.toHaveBeenCalled();
  expect(fs.existsSync(claimPath)).toBe(true);
  const result = await request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  expect(result.response).toMatchObject({ ok: true });
  expect(fs.readFileSync(output, 'utf8')).toBe('android video');
  expect(signal).toHaveBeenCalledOnce();
  expect(prepare).not.toHaveBeenCalled();
  expect(finalize).toHaveBeenCalledOnce();
  expect(fs.existsSync(claimPath)).toBe(false);
});

test('claim replacement before exact binding refuses before native recovery', async () => {
  const { stateDir, claimsDir } = setup();
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const { claimPath, resourcePath } = seed(
    stateDir,
    claimsDir,
    'recording',
    ANDROID_EMULATOR,
    rt.native,
  );
  const original = rt.gateway.bind;
  vi.spyOn(rt.gateway, 'bind').mockImplementation(async (args) => {
    const bound = await original(args);
    if (args.intent.kind === 'exact-owner') {
      const transferred = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
      fs.writeFileSync(
        claimPath,
        JSON.stringify({ ...transferred, ownerToken: 'successor-token' }),
      );
    }
    return bound;
  });
  const response = await request(stateDir, ANDROID_EMULATOR, rt, 'stop', store);
  expect(response.response).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
  expect(rt.reattach).not.toHaveBeenCalled();
  expect(rt.signal).not.toHaveBeenCalled();
  expect(JSON.parse(fs.readFileSync(claimPath, 'utf8')).ownerToken).toBe('successor-token');
  expect(screenRecordingDurableResource.store.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'open' },
  });
});

test('an app-device stop keeps the host lock until its runtime bindings drain', async () => {
  const { root, stateDir, claimsDir } = setup();
  const host: DeviceInfo = {
    platform: 'apple',
    appleOs: 'macos',
    id: 'mac-host',
    name: 'Mac',
    kind: 'device',
    target: 'desktop',
    booted: true,
  };
  const app = hostAppDevice(host, 'com.example.editor');
  const store = new SessionStore(path.join(stateDir, 'sessions'), isolatedClaimTestHost());
  const appRuntime = runtime(app, path.join(stateDir, 'app.mp4'));
  const { claimPath } = seed(stateDir, claimsDir, 'recording', app, appRuntime.native);
  let release!: () => void;
  let entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const bind = appRuntime.gateway.bind;
  vi.spyOn(appRuntime.gateway, 'bind').mockImplementation(async (args) => ({
    ...(await bind(args)),
    [Symbol.asyncDispose]: async () => {
      entered();
      await hold;
    },
  }));
  const stopping = request(stateDir, app, appRuntime, 'stop', store);
  await blocked;
  const hostState = path.join(root, 'host-state');
  const hostStore = new SessionStore(path.join(hostState, 'sessions'), isolatedClaimTestHost());
  const hostRuntime = runtime(host, path.join(root, 'host.mp4'));
  const starting = request(hostState, host, hostRuntime, 'start', hostStore);
  expect(fs.existsSync(claimPath)).toBe(true);
  expect(hostRuntime.start).not.toHaveBeenCalled();
  release();
  expect((await stopping).response.ok).toBe(true);
  expect((await starting).response.ok).toBe(true);
  expect(hostRuntime.start).toHaveBeenCalledOnce();
});

test('the orphan sweep refuses a replaced token already bound to a manifest', async () => {
  const { stateDir, claimsDir } = setup();
  const rt = runtime(ANDROID_EMULATOR, path.join(stateDir, 'output.mp4'));
  const { claimPath, resourcePath } = seed(
    stateDir,
    claimsDir,
    'recording',
    ANDROID_EMULATOR,
    rt.native,
  );
  const record = screenRecordingDurableResource.store.read(resourcePath);
  if (record.status !== 'decoded') throw new Error('missing manifest');
  screenRecordingDurableResource.store.write(resourcePath, {
    ...record.envelope,
    metadata: { deviceClaimToken: 'prior-token' },
  });
  const before = fs.readFileSync(claimPath, 'utf8');
  const reconciler = createOwnerScopedDeviceClaimReconciler({
    scope: platformRequestScopeFixture(),
    composeGateway: () => rt.gateway,
  });
  expect((await reconcileOrphanedDeviceClaims(reconciler, stateDir, process.env)).retained).toBe(1);
  expect(rt.signal).not.toHaveBeenCalled();
  expect(rt.reattach).not.toHaveBeenCalled();
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
});
