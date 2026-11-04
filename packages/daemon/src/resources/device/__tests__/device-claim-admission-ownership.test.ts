import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import * as fileHost from '@agent-device/host-kit/file';
import { createAndroidRuntimeModule } from '@agent-device/platform-android';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { audioProbeResourceStore } from '@agent-device/capture-kit/audio-probe-resource-store';
import { encodeHostAudioProbeDescriptor } from '@agent-device/capture-kit/audio-probe-descriptor-fixtures';
import type { AudioProbeLiveHandle } from '@agent-device/contracts/audio-probe-runtime';
import type { AndroidScreenRecordingTransport } from '@agent-device/contracts/screen-recording-runtime-host';
import { markScreenRecordingStartNotDispatched } from '@agent-device/contracts/screen-recording-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeHost } from '@agent-device/contracts/platform-runtime-operations';
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
import { handleSessionCloseCommands } from '../../../sessions/session-lifecycle/internal/session-close.ts';
import { platformResourceCleanupFixture } from '../../../__tests__/support/platform-resource-cleanup-fixture.ts';
import { fixture as createFixture } from './device-claim-admission-ownership.fixtures.ts';
import {
  isolatedDeviceClaimStores,
  retainOrphanedDeviceClaims,
} from '../../../__tests__/support/device-claim-store.ts';

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

const fixture = () => createFixture(setup);

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

test.each(['unknown', 'rolled-back', 'foreign'] as const)(
  'Android failed start keeps exact ownership for %s disposition',
  async (scenario) => {
    const f = fixture();
    f.publish(true);
    let old: string | undefined;
    if (scenario !== 'unknown') {
      screenRecordingDurableResource.store.write(
        f.manifestPath,
        createDurableResourceEnvelope({
          resourceKind: 'screen-recording',
          sessionId: 'recording',
          device: deviceIdentity(f.device),
          owner: localRuntimeOwner('android'),
          fence: { token: 'old', generation: 1 },
          lifecycle: 'completed',
          descriptor: { version: 1, body: {} },
        }),
      );
      old = fs.readFileSync(f.manifestPath, 'utf8');
    }
    const markers = new Map<string, string>();
    const marker = () => markers.get('/sdcard/agent-device-recording-active.json') ?? '';
    let writer = scenario === 'unknown';
    let artifact = '';
    let failActivePublication = scenario !== 'unknown';
    let interruptCheckpoint = false;
    const stop = vi.fn(async () => {
      if (scenario === 'foreign') return 'ownership-lost' as const;
      writer = false;
      return 'stopped' as const;
    });
    const transport: AndroidScreenRecordingTransport = {
      mode: 'local' as const,
      start: async ({ remotePath, admission }) => {
        if (scenario === 'unknown') throw new Error('launch outcome unknown');
        if (markers.get(admission.manifestPath) !== admission.expected)
          throw new Error('launch admission mismatch');
        markers.set(admission.manifestPath, admission.admitted);
        writer = true;
        artifact = remotePath;
        return { process: { pid: '42', startTime: '1', remotePath } };
      },
      inspect: async () => (writer ? 'owned-alive' : 'missing'),
      stop,
      exists: async (remotePath) => artifact === remotePath,
      size: async (remotePath) => (artifact === remotePath ? 5 : undefined),
      probeRunningWriters: async (remotePath: string) => ({
        conclusive: true,
        writers: writer ? [{ pid: '42', startTime: '1', remotePath }] : [],
      }),
      pullPlayable: async () => ({ stdout: '', stderr: '', exitCode: 0, playable: true }),
      remove: async (remotePath) => {
        if (artifact === remotePath) artifact = '';
        return true;
      },
      manifestPathFor: (remotePath: string) =>
        `${remotePath.slice(0, remotePath.lastIndexOf('/'))}/agent-device-recording-active.json`,
      readManifest: async (markerPath) => {
        const contents = markers.get(markerPath);
        return contents === undefined ? { status: 'missing' } : { status: 'read', contents };
      },
      compareAndSetManifest: async ({ manifestPath, expected, contents }) => {
        if ((markers.get(manifestPath) ?? null) !== expected) return 'mismatch';
        if (contents && failActivePublication && JSON.parse(contents).chunks.length > 0) {
          failActivePublication = false;
          return 'unavailable';
        }
        if (contents === null) markers.delete(manifestPath);
        else markers.set(manifestPath, contents);
        if (interruptCheckpoint && contents && JSON.parse(contents).startNoEffectConfirmed) {
          interruptCheckpoint = false;
          throw new Error('checkpoint reply lost');
        }
        return 'updated';
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
    if (scenario !== 'unknown') {
      expect(fs.readFileSync(f.manifestPath, 'utf8')).toBe(old);
      expect(stop).toHaveBeenCalledOnce();
      if (scenario === 'rolled-back') {
        expect(artifact).toBe('');
        expect(marker()).toBe('');
        expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
      } else {
        const claim = inspectDeviceClaims({}, process.env)[0]!.claim!;
        expect(claim.recordingStartPending).toBe(true);
        expect(artifact).not.toBe('');
        expect(JSON.parse(marker()).launchDisposition).toBe('admitted');
        expect(await f.record('stop', f.workspace)).toMatchObject({
          ok: false,
          error: { details: { reason: 'cleanup-unconfirmed' } },
        });
        expect(inspectDeviceClaims({}, process.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
        expect(stop).toHaveBeenCalledOnce();
      }
      return;
    }
    const claim = inspectDeviceClaims({}, process.env)[0]!.claim!;
    expect(JSON.parse(marker()).claimToken).toBe(claim.ownerToken);
    expect(await f.record('stop', f.workspace)).toMatchObject({
      ok: false,
      error: { details: { reason: 'cleanup-unconfirmed' } },
    });
    expect(marker()).not.toBe('');
    expect(inspectDeviceClaims({}, process.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
    writer = false;
    interruptCheckpoint = true;
    expect(await f.record('stop', f.workspace)).toMatchObject({
      ok: false,
      error: { details: { reason: 'cleanup-unconfirmed' } },
    });
    expect(JSON.parse(marker())).toMatchObject({
      claimToken: claim.ownerToken,
      startNoEffectConfirmed: true,
    });
    expect(inspectDeviceClaims({}, process.env)[0]?.claim?.ownerToken).toBe(claim.ownerToken);
    expect(await f.record('stop', f.workspace)).toMatchObject({
      ok: false,
      error: { details: { reason: 'recording-start-rolled-back' } },
    });
    expect(JSON.parse(marker()).startNoEffectConfirmed).toBe(true);
    expect(inspectDeviceClaims({}, process.env)).toHaveLength(0);
    expect(stop).not.toHaveBeenCalled();
  },
);

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
