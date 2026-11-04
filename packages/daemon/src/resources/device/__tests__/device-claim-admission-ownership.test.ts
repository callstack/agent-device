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
import { audioProbeResourceStore } from '@agent-device/capture-kit/audio-probe-resource-store';
import { encodeHostAudioProbeDescriptor } from '@agent-device/capture-kit/audio-probe-descriptor-fixtures';
import type { AudioProbeLiveHandle } from '@agent-device/contracts/audio-probe-runtime';
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
import { handleSessionCloseCommands } from '../../../sessions/session-lifecycle/internal/session-close.ts';
import { platformResourceCleanupFixture } from '../../../__tests__/support/platform-resource-cleanup-fixture.ts';
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
  const host = createTestHostEnvironment({
    cwd: workspace,
    env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claimsDir },
  });
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
  const closeApplication = vi.fn(async () => {});
  const finalizeApplicationClose = vi.fn(async () => ({}));
  let disposeBinding: () => Promise<void> = async () => {};
  let retryBinding: (() => Promise<void>) | undefined;
  const factsBase = createUnavailableRuntimeFactsForTest(device, owner);
  const facts = {
    ...factsBase,
    operations: {
      ...factsBase.operations,
      screenRecordingStart: { available: true as const },
      screenRecordingReattach: { available: true as const },
      screenRecordingCleanup: { available: true as const },
      closeApplication: { available: true as const },
      finalizeApplicationClose: { available: true as const },
    },
  };
  let gateway = {
    inspectFacts: async () => facts,
    bind: async () => {
      const dispose = disposeBinding;
      const retry = retryBinding;
      disposeBinding = async () => {};
      retryBinding = undefined;
      return {
        device,
        owner,
        facts,
        recoverIncompleteRecordingStart,
        operations: {
          screenRecordingStart: start,
          screenRecordingReattach: reattach,
          screenRecordingCleanup: async () => ({ status: 'cleaned' as const }),
          closeApplication,
          finalizeApplicationClose,
        },
        ...(retry ? { retryDisposal: retry } : {}),
        [Symbol.asyncDispose]: async () => await dispose(),
      };
    },
    shutdown: async () => {},
  } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
  async function scopeFor(
    command: string,
    action: string | undefined,
    cwd: string | undefined,
    state = store,
    requestRegistry = registry,
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
      leaseRegistry: requestRegistry,
      deviceRuntimeGateway: gateway,
      claimRecoveryGateway: () => gateway,
      platformServices: daemonPlatformServicesFixture(),
      platformRequestScope: scope,
    });
  }
  async function record(
    action: 'start' | 'stop',
    cwd: string | undefined,
    state = store,
    requestRegistry = registry,
  ) {
    const request = await scopeFor('record', action, cwd, state, requestRegistry);
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
    registry,
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
    closeApplication,
    setBindingDisposal: (dispose: () => Promise<void>) => {
      disposeBinding = dispose;
    },
    setBindingRetry: (retry: () => Promise<void>) => {
      retryBinding = retry;
    },
    setGateway: (value: DeviceRuntimeGateway<PlatformRuntimeOperations>) => {
      gateway = value;
    },
    setStartRecovery: (value: 'confirmed-no-effect' | 'retained') => {
      startRecovery = value;
    },
  };
}

function runClose(
  f: ReturnType<typeof fixture>,
  close: Awaited<ReturnType<ReturnType<typeof fixture>['scopeFor']>>,
) {
  return close.runLocked(
    async () =>
      await handleSessionCloseCommands({
        host: f.host,
        req: close.req,
        sessionName: close.sessionName,
        logPath: close.requestLogPath,
        sessionStore: f.store,
        leaseRegistry: f.registry,
        inspectFacts: close.inspectFacts,
        bindDevice: close.bindDevice,
        platformServices: close.platformServices,
        platformResourceCleanup: platformResourceCleanupFixture(),
      }),
  );
}

test('a record-only session keeps its exact claim for surviving app and audio owners', async () => {
  const f = fixture();
  const ref = f.publish(true);
  expect((await f.record('start', f.workspace)).ok).toBe(true);
  const claim = inspectDeviceClaims({}, process.env)[0]!.claim!;
  let enterAudio!: () => void;
  let releaseAudio!: () => void;
  const audioEntered = new Promise<void>((resolve) => {
    enterAudio = resolve;
  });
  const audioGate = new Promise<void>((resolve) => {
    releaseAudio = resolve;
  });
  const sessionDir = f.store.resolveSessionDir('recording');
  const statusPath = path.join(sessionDir, 'audio-probe.json');
  const stopped = {
    audio: 'probe' as const,
    state: 'stopped' as const,
    active: false,
    heard: false,
    source: 'system-audio' as const,
    backend: 'fixture-audio',
    durationMs: 10000,
    elapsedMs: 2000,
    bucketMs: 1000,
    sampleCount: 2,
    sourceCount: 1,
    rmsDbfs: [] as number[],
    peakDbfs: [] as number[],
  };
  const audioHandle: AudioProbeLiveHandle = {
    inspect: () => ({
      source: 'system-audio',
      backend: 'fixture-audio',
      sourceCount: 1,
      notes: [],
      statusPath,
      startedAt: 1,
      durationMs: 10000,
      bucketMs: 1000,
    }),
    status: async () => stopped,
    finish: async () => {
      enterAudio();
      await audioGate;
      return { status: 'completed', result: stopped };
    },
    forceCleanup: async () => ({ status: 'cleaned' }),
    [Symbol.asyncDispose]: async () => {},
  };
  const audioEnvelope = createDurableResourceEnvelope({
    resourceKind: 'audio-probe',
    sessionId: 'recording',
    device: deviceIdentity(f.device),
    owner: localRuntimeOwner('android'),
    fence: { token: 'audio-fence', generation: 1 },
    lifecycle: 'open',
    descriptor: encodeHostAudioProbeDescriptor({
      backend: 'macos-screencapturekit',
      source: 'system-audio',
      sourceCount: 1,
      notes: [],
      statusPath,
      startedAt: 1,
      durationMs: 10000,
      bucketMs: 1000,
      marker: { pid: 4242, startTime: 'boot+1', command: 'helper' },
    }),
  });
  const audioPath = audioProbeResourceStore.resolvePath(sessionDir);
  audioProbeResourceStore.write(audioPath, audioEnvelope);
  f.store.update(ref, {
    appBundleId: 'org.example.editor',
    audioProbe: { handle: audioHandle, envelope: audioEnvelope },
  });
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
  let enterDisposal!: () => void;
  let releaseDisposal!: () => void;
  const disposalEntered = new Promise<void>((resolve) => {
    enterDisposal = resolve;
  });
  const disposalGate = new Promise<void>((resolve) => {
    releaseDisposal = resolve;
  });
  f.setBindingDisposal(async () => {
    enterDisposal();
    await disposalGate;
  });
  const close = await f.scopeFor('close', 'org.example.editor', f.workspace);
  const closing = runClose(f, close);
  const competing = () => f.record('start', f.workspace, other, new LeaseRegistry());
  try {
    await Promise.race([
      audioEntered,
      closing.then(() => {
        throw new Error('close skipped audio');
      }),
    ]);
    expect(inspectDeviceClaims({}, process.env)[0]?.claim).toMatchObject({
      ownerToken: claim.ownerToken,
      recordingCleanupPending: true,
    });
    expect(await competing()).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
    releaseAudio();
    await Promise.race([
      disposalEntered,
      closing.then(() => {
        throw new Error('close skipped disposal');
      }),
    ]);
    expect(f.closeApplication).toHaveBeenCalledOnce();
    expect(audioProbeResourceStore.read(audioPath)).toMatchObject({
      status: 'decoded',
      envelope: { lifecycle: 'completed' },
    });
    expect(inspectDeviceClaims({}, process.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
    expect(await competing()).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
    expect(f.start).not.toHaveBeenCalled();
    releaseDisposal();
    expect((await closing).ok).toBe(true);
    await close[Symbol.asyncDispose]();
    expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
  } finally {
    releaseAudio();
    releaseDisposal();
    await closing.catch(() => {});
    await Promise.resolve(close[Symbol.asyncDispose]()).catch(() => {});
  }
});

test.each(['failed disposal', 'replacement claim'] as const)(
  'session close retains a recording reservation after %s',
  async (failure) => {
    const f = fixture();
    const ref = f.publish(true);
    expect((await f.record('start', f.workspace)).ok).toBe(true);
    f.store.update(ref, { appBundleId: 'org.example.editor' });
    expect((await f.record('stop', f.workspace)).ok).toBe(true);
    const claimFile = path.join(
      f.claimsDir,
      fs.readdirSync(f.claimsDir).find((name) => name.endsWith('.json'))!,
    );
    const original = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    let enterRetry!: () => void;
    let releaseRetry!: () => void;
    const retryEntered = new Promise<void>((resolve) => {
      enterRetry = resolve;
    });
    const retryGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    if (failure === 'failed disposal')
      f.setBindingRetry(async () => {
        enterRetry();
        await retryGate;
      });
    f.setBindingDisposal(async () => {
      if (failure === 'failed disposal') throw new Error('binding cleanup failed');
      const current = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
      fs.writeFileSync(claimFile, JSON.stringify({ ...current, ownerToken: 'successor' }));
    });
    const close = await f.scopeFor('close', 'org.example.editor', f.workspace);
    const response = await runClose(f, close);
    expect(response.ok).toBe(true);
    await expect(Promise.resolve(close[Symbol.asyncDispose]())).rejects.toThrow();
    expect(JSON.parse(fs.readFileSync(claimFile, 'utf8'))).toMatchObject({
      ownerToken: failure === 'replacement claim' ? 'successor' : original.ownerToken,
      recordingCleanupPending: true,
    });
    if (failure === 'failed disposal') {
      const foreign = await f.scopeFor('close', undefined, f.foreign);
      await expect(runClose(f, foreign)).rejects.toMatchObject({ code: 'DEVICE_IN_USE' });
      await foreign[Symbol.asyncDispose]();
      expect(JSON.parse(fs.readFileSync(claimFile, 'utf8')).ownerToken).toBe(original.ownerToken);
      const retry = await f.scopeFor('close', undefined, f.workspace);
      const closing = runClose(f, retry);
      try {
        await Promise.race([
          retryEntered,
          closing.then(() => {
            throw new Error('close skipped retry');
          }),
        ]);
        expect(JSON.parse(fs.readFileSync(claimFile, 'utf8')).ownerToken).toBe(original.ownerToken);
        releaseRetry();
        expect((await closing).ok).toBe(true);
        await retry[Symbol.asyncDispose]();
        expect(fs.existsSync(claimFile)).toBe(false);
      } finally {
        releaseRetry();
        await closing.catch(() => {});
        await Promise.resolve(retry[Symbol.asyncDispose]()).catch(() => {});
      }
    }
  },
);

test('open-session recordings bind the claim token and reject a replacement before recovery', async () => {
  const f = fixture();
  const ref = f.publish(false);
  const acquired = await acquireDeviceClaim({
    device: f.device,
    session: 'recording',
    workspace: f.workspace,
    stateDir: f.stateDir,
    env: process.env,
    reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
  });
  if (acquired.status !== 'acquired') throw new Error('claim not acquired');
  f.store.update(ref, { deviceClaim: acquired.ownership });
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

test.each(['generation', 'successor'] as const)(
  'an open-session %s mismatch cannot reach recording finish or claim coverage',
  async (changed) => {
    const f = fixture();
    const ref = f.publish(false);
    const acquired = await acquireDeviceClaim({
      device: f.device,
      session: 'recording',
      workspace: f.workspace,
      stateDir: f.stateDir,
      env: process.env,
      reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
    });
    if (acquired.status !== 'acquired') throw new Error('claim not acquired');
    f.store.update(ref, { deviceClaim: acquired.ownership });
    expect((await f.record('start', f.workspace)).ok).toBe(true);
    const claimFile = path.join(
      f.claimsDir,
      fs.readdirSync(f.claimsDir).find((name) => name.endsWith('.json'))!,
    );
    const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    const replacement =
      changed === 'successor'
        ? { ...claim, ownerToken: 'successor' }
        : {
            ...claim,
            recordingFence: {
              ...claim.recordingFence,
              generation: claim.recordingFence.generation + 1,
            },
          };
    fs.writeFileSync(claimFile, JSON.stringify(replacement));
    expect(await f.record('stop', f.workspace)).toMatchObject({
      ok: false,
      error: { code: 'DEVICE_IN_USE' },
    });
    expect(fs.existsSync(path.join(f.stateDir, 'output.mp4'))).toBe(false);
    if (changed === 'successor') {
      const install = await f.scopeFor('install', undefined, f.workspace);
      await expect(
        install.bindDevice(f.device, { required: [], preferred: [] }),
      ).rejects.toMatchObject({ code: 'DEVICE_IN_USE' });
      await install[Symbol.asyncDispose]();
    }
    expect(JSON.parse(fs.readFileSync(claimFile, 'utf8'))).toEqual(replacement);
  },
);

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

test.each(['stop', 'sweep'] as const)(
  'incomplete-start %s retains a matching manifest published during platform recovery',
  async (recovery) => {
    const f = fixture();
    f.publish(true);
    f.start.mockRejectedValueOnce(new Error('launch outcome unknown'));
    await f.record('start', f.workspace);
    const claimFile = path.join(
      f.claimsDir,
      fs.readdirSync(f.claimsDir).find((name) => name.endsWith('.json'))!,
    );
    const original = JSON.parse(fs.readFileSync(claimFile, 'utf8'));
    if (recovery === 'sweep')
      fs.writeFileSync(
        claimFile,
        JSON.stringify({ ...original, ownerPid: 999999999, ownerStartTime: 'dead' }),
      );
    f.recoverIncompleteRecordingStart.mockImplementationOnce(async () => {
      screenRecordingDurableResource.store.write(
        f.manifestPath,
        createDurableResourceEnvelope({
          resourceKind: 'screen-recording',
          sessionId: 'recording',
          device: deviceIdentity(f.device),
          owner: localRuntimeOwner('android'),
          fence: original.recordingFence,
          lifecycle: 'open',
          descriptor: { version: 1, body: {} },
          metadata: { deviceClaimToken: original.ownerToken, deviceClaimBindingVersion: 1 },
        }),
      );
      return 'confirmed-no-effect';
    });
    if (recovery === 'stop') {
      expect(await f.record('stop', f.workspace)).toMatchObject({
        ok: false,
        error: { code: 'DEVICE_IN_USE' },
      });
    } else {
      const reconciler = createOwnerScopedDeviceClaimReconciler({
        scope: f.scope,
        composeGateway: () => f.gateway,
      });
      expect(
        (await reconcileOrphanedDeviceClaims(reconciler, f.stateDir, process.env)).retained,
      ).toBe(1);
    }
    expect(JSON.parse(fs.readFileSync(claimFile, 'utf8')).ownerToken).toBe(original.ownerToken);
    expect(screenRecordingDurableResource.store.read(f.manifestPath)).toMatchObject({
      status: 'decoded',
      envelope: { fence: original.recordingFence, lifecycle: 'open' },
    });
  },
);

test('stale start recovery retains its claim when the recovery gateway cannot shut down', async () => {
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
  f.setStartRecovery('confirmed-no-effect');
  const bind = vi.fn(f.gateway.bind);
  const reconciler = createOwnerScopedDeviceClaimReconciler({
    scope: f.scope,
    composeGateway: () => ({
      ...f.gateway,
      bind,
      shutdown: async () => {
        throw new Error('gateway cleanup failed');
      },
    }),
  });
  expect((await reconcileOrphanedDeviceClaims(reconciler, f.stateDir, process.env)).retained).toBe(
    1,
  );
  expect(JSON.parse(fs.readFileSync(claimFile, 'utf8'))).toMatchObject({
    ownerToken: claim.ownerToken,
    recordingCleanupPending: true,
  });
  expect((await reconcileOrphanedDeviceClaims(reconciler, f.stateDir, process.env)).retained).toBe(
    1,
  );
  expect(bind).toHaveBeenCalledOnce();
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

test('Android incomplete-start recovery retries an interrupted exact no-effect checkpoint', async () => {
  const f = fixture();
  f.publish(true);
  let marker = '';
  let writer = true;
  let interruptCheckpoint = false;
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
      if (interruptCheckpoint && JSON.parse(contents).startNoEffectConfirmed) {
        interruptCheckpoint = false;
        throw new Error('checkpoint reply lost');
      }
    },
    removeManifest: async () => {
      return false;
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
  interruptCheckpoint = true;
  expect(await f.record('stop', f.workspace)).toMatchObject({
    ok: false,
    error: { details: { reason: 'cleanup-unconfirmed' } },
  });
  expect(JSON.parse(marker)).toMatchObject({
    claimToken: claim.ownerToken,
    startNoEffectConfirmed: true,
  });
  expect(inspectDeviceClaims({}, process.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
  expect(await f.record('stop', f.workspace)).toMatchObject({
    ok: false,
    error: { details: { reason: 'recording-start-rolled-back' } },
  });
  expect(JSON.parse(marker).startNoEffectConfirmed).toBe(true);
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
  expect(stop).not.toHaveBeenCalled();
});

test.each([true, false])(
  'incomplete-start cleanup retry respects retry capability %s',
  async (retryable) => {
    const f = fixture();
    f.publish(true);
    f.start.mockRejectedValueOnce(new Error('launch outcome unknown'));
    expect((await f.record('start', f.workspace)).ok).toBe(false);
    const claim = inspectDeviceClaims({}, process.env)[0]!.claim!;
    f.setStartRecovery('confirmed-no-effect');
    const original = f.gateway;
    const retryDisposal = vi.fn(async () => {});
    let failDisposal = true;
    const bind = vi.fn(async (...args: Parameters<typeof original.bind>) => {
      const binding = await original.bind(...args);
      return {
        ...binding,
        ...(retryable ? { retryDisposal } : {}),
        [Symbol.asyncDispose]: async () => {
          if (failDisposal) {
            failDisposal = false;
            throw new Error('dispose failed');
          }
          await binding[Symbol.asyncDispose]();
        },
      };
    });
    f.setGateway({ ...original, bind });
    expect(await f.record('stop', f.workspace)).toMatchObject({
      ok: false,
      error: { details: { reason: 'cleanup-unconfirmed' } },
    });
    expect(inspectDeviceClaims({}, process.env)[0]?.claim).toMatchObject({
      ownerToken: claim.ownerToken,
      recordingCleanupPending: true,
    });
    const retried = await f.record('stop', f.workspace);
    if (retryable) {
      expect(retried).toMatchObject({
        ok: false,
        error: { details: { reason: 'recording-start-rolled-back' } },
      });
      expect(retryDisposal).toHaveBeenCalledOnce();
      expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
    } else {
      expect(retried).toMatchObject({
        ok: false,
        error: { details: { reason: 'cleanup-unconfirmed' } },
      });
      expect(bind).toHaveBeenCalledOnce();
      expect(inspectDeviceClaims({}, process.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
    }
  },
);
