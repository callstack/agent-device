import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import * as deviceSelection from '@agent-device/device-selection/dispatch-resolve';
import {
  ANDROID_EMULATOR,
  createTestHostEnvironment,
  createUnavailableRuntimeFactsForTest,
} from '@agent-device/test-kit';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { createScreenRecordingAdmissionLedger } from '@agent-device/capture-kit/screen-recording-admission-ledger';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { ScreenRecordingStartRolledBack } from '@agent-device/contracts/screen-recording-runtime';
import {
  localRuntimeOwner,
  type DeviceRuntimeGateway,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { deviceIdentity } from '@agent-device/kernel/device';
import {
  acquireDeviceClaim,
  inspectDeviceClaims,
  reconcileOrphanedDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import { createOwnerScopedDeviceClaimReconciler } from '@agent-device/daemon-contracts/device-claim-recovery';
import { readProcessIdentityFacts } from '@agent-device/host-kit/process';
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

const setup = isolatedDeviceClaimStores('recording-reservation-address-');
afterEach(() => vi.restoreAllMocks());

function fixture() {
  const { root, stateDir, claimsDir } = setup();
  const host = createTestHostEnvironment({
    env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claimsDir },
  });
  const store = new SessionStore(path.join(stateDir, 'sessions'), host);
  const registry = new LeaseRegistry();
  const scope = platformRequestScopeFixture();
  const device = ANDROID_EMULATOR;
  const owner = localRuntimeOwner('android');
  const base = createUnavailableRuntimeFactsForTest(device, owner);
  const facts = {
    ...base,
    operations: { ...base.operations, screenRecordingStart: { available: true as const } },
  };
  let failure: unknown = new Error('Screen recording start was rolled back');
  let proof: 'confirmed-no-effect' | 'retained' = 'retained';
  let failNextDisposal = false;
  const start = vi.fn(async () => {
    throw failure;
  });
  const recover = vi.fn(async () => proof);
  const retryDisposal = vi.fn(async () => {});
  const gateway = {
    inspectFacts: async () => facts,
    bind: async () => {
      const failDisposal = failNextDisposal;
      failNextDisposal = false;
      return {
        device,
        owner,
        facts,
        operations: { screenRecordingStart: start },
        recoverIncompleteRecordingStart: recover,
        ...(failDisposal ? { retryDisposal } : {}),
        [Symbol.asyncDispose]: async () => {
          if (failDisposal) throw new Error('binding cleanup failed');
        },
      };
    },
    shutdown: async () => {},
  } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
  vi.spyOn(deviceSelection, 'resolveTargetDevice').mockResolvedValue(device);
  async function record(action: 'start' | 'stop') {
    const request = await createRequestExecutionScope({
      host,
      req: {
        token: 'test',
        session: 'recording',
        command: 'record',
        positionals: [action],
        flags: {
          recordingScope: 'device',
          ...(action === 'start' ? { platform: 'android' as const } : {}),
        },
        meta: { sessionExplicit: true },
      },
      sessionStore: store,
      leaseRegistry: registry,
      deviceRuntimeGateway: gateway,
      claimRecoveryGateway: () => gateway,
      platformServices: daemonPlatformServicesFixture(),
      platformRequestScope: scope,
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
    await request[Symbol.asyncDispose]();
    return response;
  }
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    store.resolveSessionDir('recording'),
  );
  function writeOldManifest() {
    screenRecordingDurableResource.store.write(
      resourcePath,
      createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: 'recording',
        device: deviceIdentity(device),
        owner,
        fence: { token: 'old-fence', generation: 1 },
        lifecycle: 'completed',
        descriptor: { version: 1, body: {} },
      }),
    );
    return fs.readFileSync(resourcePath, 'utf8');
  }
  return {
    root,
    stateDir,
    claimsDir,
    host,
    scope,
    gateway,
    store,
    resourcePath,
    start,
    recover,
    retryDisposal,
    record,
    writeOldManifest,
    setFailure: (value: unknown) => {
      failure = value;
    },
    setProof: (value: 'confirmed-no-effect' | 'retained') => {
      proof = value;
    },
    failNextDisposal: () => {
      failNextDisposal = true;
    },
  };
}

test('a typed platform rollback clears its exact claim after request cleanup without touching an old manifest', async () => {
  const f = fixture();
  const old = f.writeOldManifest();
  f.setFailure(new ScreenRecordingStartRolledBack(new Error('native rollback complete')));
  expect((await f.record('start')).ok).toBe(false);
  expect(f.start).toHaveBeenCalledOnce();
  expect(f.store.lookup('recording')).toBeUndefined();
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
  expect(fs.readFileSync(f.resourcePath, 'utf8')).toBe(old);
});

test('a named retry drains failed rollback cleanup before answering, without replaying an old result', async () => {
  const f = fixture();
  const old = f.writeOldManifest();
  f.setFailure(new ScreenRecordingStartRolledBack(new Error('native rollback complete')));
  f.failNextDisposal();
  await expect(f.record('start')).rejects.toThrow('binding cleanup failed');
  expect(inspectDeviceClaims({}, process.env)[0]?.claim?.recordingCleanupPending).toBe(true);
  expect(f.store.lookup('recording')).toBeUndefined();
  expect(await f.record('stop')).toMatchObject({
    ok: false,
    error: { details: { reason: 'recording-start-rolled-back' } },
  });
  expect(f.retryDisposal).toHaveBeenCalledOnce();
  expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
  expect(fs.readFileSync(f.resourcePath, 'utf8')).toBe(old);
});

test.each([true, false])(
  'named stop finds an incomplete reservation with old manifest present: %s',
  async (hasOldManifest) => {
    const f = fixture();
    const old = hasOldManifest ? f.writeOldManifest() : undefined;
    expect((await f.record('start')).ok).toBe(false);
    expect(f.store.lookup('recording')).toBeUndefined();
    const claim = inspectDeviceClaims({}, process.env)[0]!.claim!;
    expect(claim.recordingStartPending).toBe(true);
    expect(await f.record('stop')).toMatchObject({
      ok: false,
      error: { details: { reason: 'cleanup-unconfirmed' } },
    });
    expect(inspectDeviceClaims({}, process.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
    f.setProof('confirmed-no-effect');
    expect(await f.record('stop')).toMatchObject({
      ok: false,
      error: { details: { reason: 'recording-start-rolled-back' } },
    });
    expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
    expect(f.recover).toHaveBeenCalledTimes(2);
    if (old) expect(fs.readFileSync(f.resourcePath, 'utf8')).toBe(old);
    else expect(fs.existsSync(f.resourcePath)).toBe(false);
  },
);

test('a live legacy recorder is not attributed to a later matching dead claim', async () => {
  const f = fixture();
  const startChild = () =>
    spawn(process.execPath, ['-e', "process.send('ready'); setInterval(() => {}, 1000)"], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    });
  const ownerA = startChild();
  const ownerB = startChild();
  try {
    await Promise.all([once(ownerA, 'message'), once(ownerB, 'message')]);
    if (!ownerA.pid || !ownerB.pid) throw new Error('test process unavailable');
    const identityB = await readProcessIdentityFacts(ownerB.pid);
    if (!identityB.startTime) throw new Error('test owner identity unavailable');
    const exitedB = once(ownerB, 'exit');
    ownerB.kill('SIGKILL');
    await exitedB;
    const acquired = await acquireDeviceClaim({
      device: ANDROID_EMULATOR,
      session: 'recording',
      workspace: f.host.cwd,
      stateDir: f.stateDir,
      env: f.host.env,
      reconcileOrphanedDeviceClaim: retainOrphanedDeviceClaims,
    });
    if (acquired.status !== 'acquired') throw new Error('claim not acquired');
    const claimPath = path.join(
      f.claimsDir,
      fs.readdirSync(f.claimsDir).find((name) => name.endsWith('.json'))!,
    );
    const replacement = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    fs.writeFileSync(
      claimPath,
      JSON.stringify({ ...replacement, ownerPid: ownerB.pid, ownerStartTime: identityB.startTime }),
    );
    const native = path.join(f.root, 'legacy-native.mp4');
    fs.writeFileSync(native, 'owner A recording');
    screenRecordingDurableResource.store.write(
      f.resourcePath,
      createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: 'recording',
        device: deviceIdentity(ANDROID_EMULATOR),
        owner: localRuntimeOwner('android'),
        fence: { token: 'legacy-A', generation: 1 },
        lifecycle: 'open',
        descriptor: { version: 1, body: { ownerPid: ownerA.pid, outputPath: native } },
      }),
    );
    const beforeClaim = fs.readFileSync(claimPath, 'utf8');
    const beforeManifest = fs.readFileSync(f.resourcePath, 'utf8');
    const reconciler = createOwnerScopedDeviceClaimReconciler({
      scope: f.scope,
      composeGateway: () => f.gateway,
    });
    expect((await reconcileOrphanedDeviceClaims(reconciler, f.stateDir, f.host.env)).retained).toBe(
      1,
    );
    expect(await f.record('stop')).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
    expect(fs.readFileSync(claimPath, 'utf8')).toBe(beforeClaim);
    expect(fs.readFileSync(f.resourcePath, 'utf8')).toBe(beforeManifest);
    expect(fs.readFileSync(native, 'utf8')).toBe('owner A recording');
    expect(f.recover).not.toHaveBeenCalled();
    expect(ownerA.exitCode).toBeNull();
    expect(ownerA.signalCode).toBeNull();
  } finally {
    for (const child of [ownerA, ownerB]) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
    }
  }
});
