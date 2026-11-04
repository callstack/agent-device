import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, test, vi } from 'vitest';
import * as deviceSelection from '@agent-device/device-selection/dispatch-resolve';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import { AppError } from '@agent-device/kernel/errors';
import { screenRecordingDurableResource } from '@agent-device/capture-kit/screen-recording-session-resource';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import { audioProbeResourceStore } from '@agent-device/capture-kit/audio-probe-resource-store';
import { encodeHostAudioProbeDescriptor } from '@agent-device/capture-kit/audio-probe-descriptor-fixtures';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { deviceIdentity } from '@agent-device/kernel/device';
import { readProcessIdentityFacts } from '@agent-device/host-kit/process';
import { reconcileOrphanedDeviceClaims } from '@agent-device/daemon-contracts/device-claims';
import { createOwnerScopedDeviceClaimReconciler } from '@agent-device/daemon-contracts/device-claim-recovery';
import { isolatedDeviceClaimStores } from '../../../__tests__/support/device-claim-store.ts';
import { seed } from './device-claim-admission-recording.fixtures.ts';
import { cleanupCrashFixture } from './recording-cleanup-crash.fixtures.ts';

const setup = isolatedDeviceClaimStores('recording-cleanup-crash-');
afterEach(() => vi.restoreAllMocks());
const childScript = fileURLToPath(
  new URL('./recording-cleanup-crash-child.fixtures.ts', import.meta.url),
);

async function crashAt(stateDir: string, claimsDir: string, phase: string) {
  const child = spawn(
    process.execPath,
    ['--experimental-strip-types', childScript, stateDir, claimsDir, phase],
    {
      cwd: process.cwd(),
      env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: claimsDir },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const exited = once(child, 'exit');
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`checkpoint timeout: ${stderr}`)), 15000);
      child.stdout.once('data', () => {
        clearTimeout(timer);
        resolve();
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`child exited: ${stderr}`));
      });
      child.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
}

function fixture() {
  const { stateDir, claimsDir } = setup();
  vi.spyOn(deviceSelection, 'resolveTargetDevice').mockResolvedValue(IOS_SIMULATOR);
  const native = path.join(stateDir, 'native.mp4');
  fs.writeFileSync(native, 'original recording');
  const seeded = seed(stateDir, claimsDir, 'recording', IOS_SIMULATOR, native);
  const record = screenRecordingDurableResource.store.read(seeded.resourcePath);
  if (record.status !== 'decoded') throw new Error('missing fixture manifest');
  screenRecordingDurableResource.store.write(seeded.resourcePath, {
    ...record.envelope,
    metadata: { ...record.envelope.metadata, recordingCleanupScope: 'local-drained' },
  });
  return {
    stateDir,
    claimsDir,
    native,
    ...seeded,
    runtime: cleanupCrashFixture(stateDir, claimsDir, false),
  };
}

function addLegacyPhase(claimPath: string, phase: string) {
  const claim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  fs.writeFileSync(claimPath, JSON.stringify({ ...claim, recordingCleanupProof: phase }));
}

test.each([
  'stop-prepared',
  'stop-completed-release',
  'stop-drained-release',
  'stop-completed-retain',
  'stop-drained-retain',
] as const)(
  'legacy %s metadata cannot clear a crashed owner with a surviving resource',
  async (phase) => {
    const f = fixture();
    const resource = spawn(
      process.execPath,
      ['-e', String.raw`process.stdout.write('ready\n'); process.stdin.resume()`],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const exited = once(resource, 'exit');
    try {
      await once(resource.stdout, 'data');
      await crashAt(f.stateDir, f.claimsDir, phase);
      addLegacyPhase(f.claimPath, phase);
      const beforeClaim = fs.readFileSync(f.claimPath, 'utf8');
      const beforeManifest = fs.readFileSync(f.resourcePath, 'utf8');
      const beforeEffects = fs.existsSync(f.runtime.events)
        ? fs.readFileSync(f.runtime.events, 'utf8')
        : '';
      const claim = JSON.parse(beforeClaim);
      expect(claim).toMatchObject({ ownerToken: 'original-token', recordingCleanupPending: true });
      expect(claim.ownerPid).not.toBe(process.pid);
      if (phase !== 'stop-prepared') {
        expect(beforeEffects).toContain('finish\n');
        expect(fs.readFileSync(f.runtime.output, 'utf8')).toBe('preserved export');
      }
      if (phase.startsWith('stop-drained-')) expect(beforeEffects).toContain('dispose\n');
      expect(await f.runtime.stop()).toMatchObject({
        ok: false,
        error: { details: { reason: 'cleanup-unconfirmed' } },
      });
      const reconcile = createOwnerScopedDeviceClaimReconciler({
        scope: f.runtime.platformScope,
        composeGateway: () => f.runtime.gateway,
      });
      expect(
        (await reconcileOrphanedDeviceClaims(reconcile, f.stateDir, f.runtime.host.env)).retained,
      ).toBe(1);
      const otherState = path.join(f.stateDir, '..', 'other');
      fs.mkdirSync(otherState, { recursive: true });
      const competing = cleanupCrashFixture(otherState, f.claimsDir);
      expect(await competing.start()).toMatchObject({
        ok: false,
        error: { code: 'DEVICE_IN_USE' },
      });
      expect(fs.existsSync(competing.events)).toBe(true);
      expect(fs.readFileSync(competing.events, 'utf8')).not.toContain('start\n');
      expect(resource.exitCode).toBeNull();
      expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(beforeClaim);
      expect(fs.readFileSync(f.resourcePath, 'utf8')).toBe(beforeManifest);
      expect(fs.readFileSync(f.native, 'utf8')).toBe('original recording');
      expect(fs.existsSync(f.runtime.events) ? fs.readFileSync(f.runtime.events, 'utf8') : '').toBe(
        beforeEffects,
      );
    } finally {
      if (resource.exitCode === null && resource.signalCode === null) resource.kill('SIGKILL');
      await exited;
    }
  },
);

test('a lost failed-disposal retry retains the completed export and exact claim', async () => {
  const f = fixture();
  await crashAt(f.stateDir, f.claimsDir, 'failed-disposal');
  addLegacyPhase(f.claimPath, 'stop-completed-release');
  const claim = fs.readFileSync(f.claimPath, 'utf8');
  const events = fs.readFileSync(f.runtime.events, 'utf8');
  expect(events).toContain('finish\n');
  expect(events).toContain('dispose\n');
  expect(await f.runtime.stop()).toMatchObject({
    ok: false,
    error: { details: { reason: 'cleanup-unconfirmed' } },
  });
  expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(claim);
  expect(fs.readFileSync(f.runtime.events, 'utf8')).toBe(events);
  expect(fs.readFileSync(f.runtime.output, 'utf8')).toBe('preserved export');
});

test('an unsettled test-owned child can still write after the daemon exits', async () => {
  const f = fixture();
  await crashAt(f.stateDir, f.claimsDir, 'stop-prepared');
  addLegacyPhase(f.claimPath, 'stop-prepared');
  const child = spawn(
    process.execPath,
    [
      '-e',
      String.raw`process.stdout.write('ready\n'); process.stdin.once('data', () => { require('node:fs').appendFileSync(process.argv[1], 'late child\n'); process.exit(0); });`,
      f.runtime.events,
    ],
    { detached: true, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = once(child, 'exit');
  try {
    await once(child.stdout, 'data');
    const beforeClaim = fs.readFileSync(f.claimPath, 'utf8');
    expect(await f.runtime.stop()).toMatchObject({
      ok: false,
      error: { details: { reason: 'cleanup-unconfirmed' } },
    });
    expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(beforeClaim);
    child.stdin.write('continue\n');
    await exited;
    expect(fs.readFileSync(f.runtime.events, 'utf8')).toBe('late child\n');
    expect(fs.existsSync(f.claimPath)).toBe(true);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await exited;
  }
});

test('cold stop transfers the recording while retaining the old daemon session obligation', async () => {
  const { stateDir, claimsDir } = setup();
  vi.spyOn(deviceSelection, 'resolveTargetDevice').mockResolvedValue(IOS_SIMULATOR);
  const resource = spawn(
    process.execPath,
    ['-e', String.raw`process.stdout.write('ready\n'); process.stdin.resume()`],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  const exited = once(resource, 'exit');
  try {
    await once(resource.stdout, 'data');
    await crashAt(stateDir, claimsDir, 'active-app');
    const claimPath = path.join(
      claimsDir,
      fs.readdirSync(claimsDir).find((name) => name.endsWith('.json'))!,
    );
    const oldClaim = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    expect(oldClaim.recordingSessionOwner).toEqual({
      pid: oldClaim.ownerPid,
      startTime: oldClaim.ownerStartTime,
    });
    expect(oldClaim.recordingSessionOwner.pid).not.toBe(process.pid);
    const runtime = cleanupCrashFixture(stateDir, claimsDir, false);
    expect(await runtime.stop()).toMatchObject({ ok: true });
    const transferred = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
    expect(transferred).toMatchObject({
      ownerToken: oldClaim.ownerToken,
      claimOwnerKind: 'open-session',
      recordingSessionOwner: oldClaim.recordingSessionOwner,
    });
    expect(transferred.ownerPid).toBe(process.pid);
    expect(fs.readFileSync(runtime.output, 'utf8')).toBe('preserved export');
    const reconcile = createOwnerScopedDeviceClaimReconciler({
      scope: runtime.platformScope,
      composeGateway: () => runtime.gateway,
    });
    expect(await reconcile(transferred)).toMatchObject({
      status: 'retained',
      reason: 'screen-recording-session-owner-pending',
    });
    expect(resource.exitCode).toBeNull();
    const otherState = path.join(stateDir, '..', 'other');
    fs.mkdirSync(otherState, { recursive: true });
    const competing = cleanupCrashFixture(otherState, claimsDir);
    expect(await competing.start()).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
    expect(fs.readFileSync(competing.events, 'utf8')).not.toContain('start\n');
    expect(JSON.parse(fs.readFileSync(claimPath, 'utf8')).recordingSessionOwner).toEqual(
      oldClaim.recordingSessionOwner,
    );
  } finally {
    if (resource.exitCode === null && resource.signalCode === null) resource.kill('SIGKILL');
    await exited;
  }
});

test('a cold selectorless stop replays the pending export when the device is unavailable', async () => {
  const { stateDir, claimsDir } = setup();
  await crashAt(stateDir, claimsDir, 'pending-native');
  const runtime = cleanupCrashFixture(stateDir, claimsDir, false);
  const claimPath = path.join(
    claimsDir,
    fs.readdirSync(claimsDir).find((name) => name.endsWith('.json'))!,
  );
  const resourcePath = screenRecordingDurableResource.store.resolvePath(
    path.join(stateDir, 'sessions', 'recording'),
  );
  const before = fs.readFileSync(claimPath, 'utf8');
  const manifest = fs.readFileSync(resourcePath, 'utf8');
  const effects = fs.readFileSync(runtime.events, 'utf8');
  vi.spyOn(deviceSelection, 'resolveTargetDevice').mockRejectedValue(
    new AppError('DEVICE_NOT_FOUND', 'device unavailable'),
  );
  expect(await runtime.stop()).toMatchObject({ ok: true, data: { outPath: runtime.output } });
  expect(fs.readFileSync(runtime.output, 'utf8')).toBe('preserved export');
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe(manifest);
  expect(fs.readFileSync(runtime.events, 'utf8')).toBe(effects);
  const secondChunk = path.join(stateDir, 'export.part-002.mp4');
  expect(fs.readFileSync(secondChunk, 'utf8')).toBe('preserved second chunk');
  fs.unlinkSync(secondChunk);
  expect(await runtime.stop()).toMatchObject({ ok: false });
  expect(fs.readFileSync(runtime.output, 'utf8')).toBe('preserved export');
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe(manifest);
  expect(fs.readFileSync(runtime.events, 'utf8')).toBe(effects);
  fs.writeFileSync(secondChunk, 'preserved second chunk');
  expect(await runtime.stop()).toMatchObject({
    ok: true,
    data: { chunks: [{ path: runtime.output }, { path: secondChunk }] },
  });
  const caller = new AbortController();
  caller.abort();
  const canceled = cleanupCrashFixture(
    stateDir,
    claimsDir,
    false,
    false,
    false,
    false,
    false,
    caller.signal,
  );
  await expect(canceled.stop()).rejects.toMatchObject({ name: 'AbortError' });
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
  const replacement = { ...JSON.parse(before), ownerToken: 'replacement-token' };
  fs.writeFileSync(claimPath, JSON.stringify(replacement));
  expect(await runtime.stop()).toMatchObject({ ok: false });
  expect(JSON.parse(fs.readFileSync(claimPath, 'utf8'))).toEqual(replacement);
  expect(fs.readFileSync(resourcePath, 'utf8')).toBe(manifest);
  fs.writeFileSync(claimPath, before);
  const recorded = screenRecordingDurableResource.store.read(resourcePath);
  if (recorded.status !== 'decoded') throw new Error('missing pending recording');
  screenRecordingDurableResource.store.write(resourcePath, {
    ...recorded.envelope,
    metadata: { ...recorded.envelope.metadata, phase: 'completing' },
  });
  expect(await runtime.stop()).toMatchObject({ ok: true, data: { outPath: runtime.output } });
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
  fs.writeFileSync(resourcePath, manifest);
  for (const change of ['missing-binding', 'different-descriptor'] as const) {
    const metadata = { ...recorded.envelope.metadata };
    if (change === 'missing-binding') delete metadata.pendingCompletionBinding;
    screenRecordingDurableResource.store.write(resourcePath, {
      ...recorded.envelope,
      metadata,
      ...(change === 'different-descriptor'
        ? { descriptor: { ...recorded.envelope.descriptor, body: { replaced: true } } }
        : {}),
    });
    expect(await runtime.stop()).toMatchObject({ ok: false });
    expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
    fs.writeFileSync(resourcePath, manifest);
  }
  fs.unlinkSync(runtime.output);
  expect(await runtime.stop()).toMatchObject({ ok: false });
  expect(fs.readFileSync(claimPath, 'utf8')).toBe(before);
});

test('a legacy open-session claim preserves its unproven session owner after export', async () => {
  const f = fixture();
  const old = JSON.parse(fs.readFileSync(f.claimPath, 'utf8'));
  delete old.transientCommand;
  old.claimOwnerKind = 'open-session';
  fs.writeFileSync(f.claimPath, JSON.stringify(old));
  const before = fs.readFileSync(f.claimPath, 'utf8');
  const reconciler = createOwnerScopedDeviceClaimReconciler({
    scope: f.runtime.platformScope,
    composeGateway: () => f.runtime.gateway,
  });
  expect(
    (await reconcileOrphanedDeviceClaims(reconciler, f.stateDir, f.runtime.host.env)).retained,
  ).toBe(1);
  expect(fs.readFileSync(f.claimPath, 'utf8')).toBe(before);
  expect(await f.runtime.stop()).toMatchObject({ ok: true, data: { outPath: f.runtime.output } });
  const claim = JSON.parse(fs.readFileSync(f.claimPath, 'utf8'));
  expect(claim).toMatchObject({
    ownerToken: old.ownerToken,
    claimOwnerKind: 'open-session',
    recordingSessionOwner: { pid: old.ownerPid, startTime: old.ownerStartTime },
  });
  expect(fs.readFileSync(f.runtime.output, 'utf8')).toBe('preserved export');
  expect(await reconciler(claim)).toMatchObject({
    status: 'retained',
    reason: 'screen-recording-session-owner-pending',
  });
  const otherState = path.join(f.stateDir, '..', 'legacy-competitor');
  fs.mkdirSync(otherState, { recursive: true });
  const competing = cleanupCrashFixture(otherState, f.claimsDir);
  expect(await competing.start()).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
  expect(fs.readFileSync(competing.events, 'utf8')).not.toContain('start\n');
});

test('an internal recovery deadline replays the pending output without canceling the caller', async () => {
  const { stateDir, claimsDir } = setup();
  await crashAt(stateDir, claimsDir, 'pending-native');
  const claimPath = path.join(
    claimsDir,
    fs.readdirSync(claimsDir).find((name) => name.endsWith('.json'))!,
  );
  const old = JSON.parse(fs.readFileSync(claimPath, 'utf8'));
  delete old.recordingCleanupPending;
  fs.writeFileSync(claimPath, JSON.stringify(old));
  vi.spyOn(deviceSelection, 'resolveTargetDevice').mockResolvedValue(IOS_SIMULATOR);
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const runtime = cleanupCrashFixture(
    stateDir,
    claimsDir,
    false,
    false,
    false,
    false,
    false,
    undefined,
    enter,
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const stopping = runtime.stop();
    await entered;
    await vi.advanceTimersByTimeAsync(5001);
    expect(await stopping).toMatchObject({ ok: true, data: { outPath: runtime.output } });
    expect(JSON.parse(fs.readFileSync(claimPath, 'utf8'))).toMatchObject({
      ownerToken: old.ownerToken,
      recordingCleanupPending: true,
    });
    expect(fs.readFileSync(runtime.output, 'utf8')).toBe('preserved export');
  } finally {
    vi.useRealTimers();
  }
});

test('cold recording export preserves an independently owned live audio resource', async () => {
  const f = fixture();
  const audio = spawn(
    process.execPath,
    ['-e', String.raw`process.stdout.write('ready\n'); process.stdin.resume()`],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  const exited = once(audio, 'exit');
  try {
    await once(audio.stdout, 'data');
    const identity = await readProcessIdentityFacts(audio.pid!);
    if (!identity.startTime || !identity.command) throw new Error('audio identity unavailable');
    const audioPath = audioProbeResourceStore.resolvePath(
      path.join(f.stateDir, 'sessions', 'recording'),
    );
    audioProbeResourceStore.write(
      audioPath,
      createDurableResourceEnvelope({
        resourceKind: 'audio-probe',
        sessionId: 'recording',
        device: deviceIdentity(IOS_SIMULATOR),
        owner: localRuntimeOwner('apple'),
        fence: { token: 'audio-fence', generation: 1 },
        lifecycle: 'open',
        descriptor: encodeHostAudioProbeDescriptor({
          backend: 'macos-screencapturekit',
          source: 'system-audio',
          sourceCount: 1,
          notes: [],
          statusPath: path.join(f.stateDir, 'audio-status.json'),
          startedAt: 1,
          durationMs: 10000,
          bucketMs: 1000,
          marker: { pid: audio.pid!, startTime: identity.startTime, command: identity.command },
        }),
      }),
    );
    const beforeAudio = fs.readFileSync(audioPath, 'utf8');
    expect(await f.runtime.stop()).toMatchObject({ ok: true, data: { outPath: f.runtime.output } });
    expect(fs.readFileSync(f.runtime.output, 'utf8')).toBe('preserved export');
    expect(fs.readFileSync(audioPath, 'utf8')).toBe(beforeAudio);
    expect(audio.exitCode).toBeNull();
    const claim = JSON.parse(fs.readFileSync(f.claimPath, 'utf8'));
    expect(claim).toMatchObject({
      ownerToken: 'original-token',
      recordingSessionOwner: { pid: 999999999 },
    });
    const reconcile = createOwnerScopedDeviceClaimReconciler({
      scope: f.runtime.platformScope,
      composeGateway: () => f.runtime.gateway,
    });
    expect(await reconcile(claim)).toMatchObject({
      status: 'retained',
      reason: 'screen-recording-session-owner-pending',
    });
    const otherState = path.join(f.stateDir, '..', 'audio-competitor');
    fs.mkdirSync(otherState, { recursive: true });
    const competing = cleanupCrashFixture(otherState, f.claimsDir);
    expect(await competing.start()).toMatchObject({ ok: false, error: { code: 'DEVICE_IN_USE' } });
    expect(fs.readFileSync(competing.events, 'utf8')).not.toContain('start\n');
    expect(audio.exitCode).toBeNull();
  } finally {
    if (audio.exitCode === null && audio.signalCode === null) audio.kill('SIGKILL');
    await exited;
  }
});
