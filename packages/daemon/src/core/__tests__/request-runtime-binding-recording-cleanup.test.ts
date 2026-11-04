import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as fileHost from '@agent-device/host-kit/file';
import { expect, test, vi } from 'vitest';
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
import {
  encodeScreenRecordingCompletionMetadata,
  screenRecordingDurableResource,
} from '@agent-device/capture-kit/screen-recording-session-resource';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { deviceIdentity } from '@agent-device/kernel/device';
import {
  canonicalLocalDeviceKey,
  clearDeviceClaim,
  inspectDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import { createOwnerScopedDeviceClaimReconciler } from '@agent-device/daemon-contracts/device-claim-recovery';
import { SessionStore } from '../session-store.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { createRequestExecutionScope } from '../../server/request-execution-scope.ts';
import { handleRecordCommand } from '../../sessions/handlers/record-runtime.ts';
import { isolatedDeviceClaimStores } from '../../__tests__/support/device-claim-store.ts';
import { platformRequestScopeFixture } from '../../__tests__/support/unavailable-device-runtime-gateway.ts';
import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';

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

const setup = isolatedDeviceClaimStores('recording-cleanup-authority-');

function fixture(retryable = true) {
  const { stateDir, claimsDir } = setup();
  const host = createTestHostEnvironment({
    env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claimsDir },
  });
  const store = new SessionStore(path.join(stateDir, 'sessions'), host);
  const registry = new LeaseRegistry();
  const scope = platformRequestScopeFixture();
  const device = ANDROID_EMULATOR;
  const owner = localRuntimeOwner('android');
  const output = path.join(stateDir, 'output.mp4');
  const native = path.join(stateDir, 'native.mp4');
  fs.writeFileSync(native, 'recorded bytes');
  const key = canonicalLocalDeviceKey(deviceIdentity(device));
  const claimPath = path.join(
    claimsDir,
    `${crypto.createHash('sha256').update(key).digest('hex')}.json`,
  );
  fs.mkdirSync(claimsDir, { recursive: true });
  fs.writeFileSync(
    claimPath,
    JSON.stringify({
      schemaVersion: 3,
      deviceKey: key,
      device: { ...deviceIdentity(device), name: device.name },
      session: 'recording',
      workspace: host.cwd,
      stateDir,
      ownerPid: 999999999,
      ownerStartTime: 'dead',
      ownerToken: 'original-token',
      createdAtMs: 1,
      updatedAtMs: 1,
      claimOwnerKind: 'open-session',
      recordingFence: { token: 'recording-fence', generation: 3 },
      recordingRuntimeOwner: owner,
    }),
  );
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    path.join(stateDir, 'sessions', 'recording'),
  );
  screenRecordingDurableResource.store.write(
    resourcePath,
    createDurableResourceEnvelope({
      resourceKind: 'screen-recording',
      sessionId: 'recording',
      device: deviceIdentity(device),
      owner,
      fence: { token: 'recording-fence', generation: 3 },
      lifecycle: 'open',
      descriptor: { version: 1, body: {} },
      metadata: {
        deviceClaimToken: 'original-token',
        deviceClaimBindingVersion: 1,
      },
    }),
  );
  const finish = vi.fn(async () => {
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
  let nativeCleanupPending = false;
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
        nativeCleanupPending
          ? { status: 'cleanup-pending', reason: 'cleanup-unconfirmed' }
          : { status: 'cleaned' },
    },
  );
  const reattach = vi.fn(async () => ({ status: 'export' as const, handle }));
  let releaseRetry!: () => void;
  let retryEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    retryEntered = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    releaseRetry = resolve;
  });
  const retryDisposal = vi.fn(async () => {
    retryEntered();
    await hold;
  });
  const exactDispose = vi.fn(async () => {
    throw new Error('binding cleanup failed');
  });
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
  const gateway: DeviceRuntimeGateway<PlatformRuntimeOperations> = {
    inspectFacts: async () => facts,
    bind: async ({ intent }) => ({
      device,
      owner,
      facts,
      operations: {
        screenRecordingStart: async () => {
          throw new Error('unexpected start');
        },
        screenRecordingReattach: reattach,
        screenRecordingCleanup: async () => ({ status: 'cleaned' as const }),
      },
      ...(intent.kind === 'exact-owner' && retryable ? { retryDisposal } : {}),
      [Symbol.asyncDispose]: intent.kind === 'exact-owner' ? exactDispose : async () => {},
    }),
    shutdown: async () => {},
  };
  async function stop() {
    const request = await createRequestExecutionScope({
      host,
      req: {
        token: 't',
        session: 'recording',
        command: 'record',
        positionals: ['stop'],
        flags: { recordingScope: 'device' },
      },
      sessionStore: store,
      leaseRegistry: registry,
      deviceRuntimeGateway: gateway,
      claimRecoveryGateway: () => gateway,
      platformServices: daemonPlatformServicesFixture(),
      platformRequestScope: scope,
    });
    if (!store.lookup(request.sessionName))
      store.publish(request.sessionName, {
        name: request.sessionName,
        device,
        createdAt: 1,
        actions: [],
      });
    const response = await request.runLocked(
      async () =>
        await handleRecordCommand({
          req: request.req,
          sessionName: request.sessionName,
          sessionStore: store,
          bindDevice: request.bindDevice,
          bindExactDevice: request.bindExactDevice,
          admissionLedger: createScreenRecordingAdmissionLedger(),
          requestScope: scope,
          platformServices: request.platformServices,
          retainDeviceExecutionLock: request.retainDeviceExecutionLock,
          throwIfCanceled: request.throwIfCanceled,
        }),
    );
    let cleanupError: unknown;
    try {
      await request[Symbol.asyncDispose]();
    } catch (error) {
      cleanupError = error;
    }
    return { response, cleanupError };
  }
  return {
    stateDir,
    host,
    store,
    output,
    native,
    key,
    claimPath,
    resourcePath,
    device,
    handle,
    setNativeCleanupPending: (pending: boolean) => {
      nativeCleanupPending = pending;
    },
    gateway,
    scope,
    finish,
    reattach,
    exactDispose,
    retryDisposal,
    entered,
    releaseRetry,
    stop,
  };
}

test('completed replay keeps native cleanup authority until the exact handle settles', async () => {
  const f = fixture();
  const open = screenRecordingDurableResource.store.read(f.resourcePath);
  if (open.status !== 'decoded') throw new Error('missing recording');
  fs.writeFileSync(f.output, 'recorded bytes');
  f.store.publish('recording', {
    name: 'recording',
    device: f.device,
    createdAt: 1,
    actions: [],
    screenRecording: { handle: f.handle, envelope: open.envelope },
  });
  f.setNativeCleanupPending(true);
  const publish = fileHost.publishFileSync;
  let changed = false;
  const intercept = vi.spyOn(fileHost, 'publishFileSync').mockImplementation((options) => {
    publish(options);
    if (changed || options.destination !== f.claimPath) return;
    const claim = JSON.parse(fs.readFileSync(f.claimPath, 'utf8'));
    if (!claim.recordingCleanupPending) return;
    changed = true;
    screenRecordingDurableResource.store.write(f.resourcePath, {
      ...open.envelope,
      lifecycle: 'completed',
      metadata: {
        ...open.envelope.metadata,
        ...encodeScreenRecordingCompletionMetadata({
          backend: 'fixture',
          outPath: f.output,
          startedAt: 1,
          completedAt: 2,
          scope: 'device',
          showTouches: false,
          recordOnlySession: false,
        }),
      },
    });
  });
  try {
    expect((await f.stop()).response).toMatchObject({ ok: true });
  } finally {
    intercept.mockRestore();
  }
  expect(changed).toBe(true);
  expect(inspectDeviceClaims({}, process.env)[0]?.claim).toMatchObject({
    ownerToken: 'original-token',
    recordingCleanupPending: true,
  });
  expect(inspectDeviceClaims({}, process.env)[0]?.claim).not.toHaveProperty(
    'recordingCleanupProof',
  );
  expect(f.store.get('recording')?.screenRecording).toBeDefined();
  expect((await f.stop()).response).toMatchObject({
    ok: false,
    error: { details: { reason: 'cleanup-unconfirmed' } },
  });
  expect(fs.existsSync(f.claimPath)).toBe(true);
  f.setNativeCleanupPending(false);
  expect((await f.stop()).response).toMatchObject({ ok: true });
  expect(fs.existsSync(f.claimPath)).toBe(false);
  expect(fs.readFileSync(f.output, 'utf8')).toBe('recorded bytes');
  expect(f.store.get('recording')?.screenRecording).toBeUndefined();
});

test('a failed binding disposal retains the completed export until its authority drains on stop retry', async () => {
  const f = fixture();
  const first = await f.stop();
  expect(first.response.ok).toBe(true);
  expect(first.cleanupError).toBeInstanceOf(Error);
  expect(fs.readFileSync(f.output, 'utf8')).toBe('recorded bytes');
  expect(fs.readFileSync(f.native, 'utf8')).toBe('recorded bytes');
  expect(screenRecordingDurableResource.store.read(f.resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: { lifecycle: 'completed' },
  });
  const claim = inspectDeviceClaims({}, process.env)[0]?.claim;
  expect(claim).toMatchObject({ ownerToken: 'original-token', recordingCleanupPending: true });
  const reconciler = createOwnerScopedDeviceClaimReconciler({
    scope: f.scope,
    composeGateway: () => f.gateway,
  });
  expect(await reconciler(claim!)).toMatchObject({
    status: 'retained',
    reason: 'screen-recording-binding-cleanup-pending',
  });
  const ownership = f.store.recordingCleanup('recording')!.ownership;
  expect(await clearDeviceClaim(ownership, process.env)).toBe('cleanup-pending');
  const retry = f.stop();
  await f.entered;
  expect(fs.existsSync(f.claimPath)).toBe(true);
  expect(f.retryDisposal).toHaveBeenCalledOnce();
  f.releaseRetry();
  const result = await retry;
  expect(result.response).toMatchObject({ ok: true });
  expect(result.cleanupError).toBeUndefined();
  expect(fs.existsSync(f.claimPath)).toBe(false);
  expect(fs.readFileSync(f.output, 'utf8')).toBe('recorded bytes');
  expect(f.reattach).toHaveBeenCalledOnce();
  expect(f.finish).toHaveBeenCalledOnce();
});

test('a replacement claim is not cleared when the retained cleanup settles', async () => {
  const f = fixture();
  await f.stop();
  const retry = f.stop();
  await f.entered;
  const claim = JSON.parse(fs.readFileSync(f.claimPath, 'utf8'));
  fs.writeFileSync(f.claimPath, JSON.stringify({ ...claim, ownerToken: 'successor-token' }));
  f.releaseRetry();
  const result = await retry;
  expect(result.response).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
  expect(JSON.parse(fs.readFileSync(f.claimPath, 'utf8')).ownerToken).toBe('successor-token');
  expect(fs.readFileSync(f.output, 'utf8')).toBe('recorded bytes');
});

test('a binding without explicit retry authority stays reserved', async () => {
  const f = fixture(false);
  await f.stop();
  const retry = await f.stop();
  expect(retry.response).toMatchObject({
    ok: false,
    error: { code: 'COMMAND_FAILED', details: { reason: 'cleanup-unconfirmed' } },
  });
  expect(f.exactDispose).toHaveBeenCalledOnce();
  expect(fs.existsSync(f.claimPath)).toBe(true);
  expect(fs.readFileSync(f.output, 'utf8')).toBe('recorded bytes');
});
