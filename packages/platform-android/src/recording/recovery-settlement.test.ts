import { expect, test, vi } from 'vitest';
import path from 'node:path';
import { mkdtempForTestSync } from '@agent-device/test-kit';
import { recoverScreenRecordingResourceAfterDaemonLock } from '@agent-device/capture-kit/screen-recording-recovery';
import type { DeviceRuntimeGateway } from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { screenRecordingResourceStore } from '@agent-device/capture-kit/screen-recording-resource-store';
import type { DurableCaptureProgress } from '@agent-device/contracts/durable-resource';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

async function setup(initial: 'owned-alive' | 'missing' = 'owned-alive', twoChunks = false) {
  let manifest = '';
  let state: 'owned-alive' | 'missing' | 'ownership-lost' = initial;
  let loseAtStop = false;
  let olderState: 'owned-alive' | 'missing' = 'owned-alive';
  let olderFailure = twoChunks;
  let failAfterSignal: 'throw' | 'uncertain' | undefined;
  let missingProbes = 0;
  const files = new Set<string>();
  const signal = vi.fn(async () => {
    state = 'missing';
    return 'stopped' as const;
  });
  const remove = vi.fn(async (name: string) => {
    files.delete(name);
    return true;
  });
  const removeManifest = vi.fn(async () => {
    manifest = '';
    return true;
  });
  const finalize = vi.fn(async () => ({}));
  const runtime = await bindAndroidScreenRecordingRuntime({
    host: recordingHost({
      start: async ({ remotePath }: { remotePath: string }) => {
        files.add(remotePath);
        return { remotePid: '42' };
      },
      inspect: async (identity: { pid: string }) => {
        if (identity.pid === '41') return olderState;
        if (state === 'missing' && failAfterSignal && ++missingProbes === 2) {
          const failure = failAfterSignal;
          failAfterSignal = undefined;
          if (failure === 'throw') throw new Error('probe unavailable');
          return 'uncertain' as const;
        }
        return state;
      },
      stop: async (identity: { pid: string }) => {
        if (identity.pid === '41') {
          if (olderFailure) {
            olderFailure = false;
            throw new Error('older stop failed');
          }
          olderState = 'missing';
          return 'stopped' as const;
        }
        if (loseAtStop) {
          state = 'ownership-lost';
          return 'ownership-lost' as const;
        }
        return state === 'missing' ? ('already-missing' as const) : await signal();
      },
      exists: async (name: string) => files.has(name),
      remove,
      removeManifest,
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      finalize: { complete: finalize },
    }),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  if (twoChunks) {
    const marker = JSON.parse(manifest);
    const active = marker.chunks[0];
    const olderPath = '/sdcard/agent-device-recording-123.mp4';
    files.add(olderPath);
    marker.chunks = [
      { ...active, index: 1, remotePid: '41', remotePath: olderPath },
      { ...active, index: 2 },
    ];
    manifest = JSON.stringify(marker);
  }
  const attached = await runtime.screenRecordingReattach({ envelope: started.envelope });
  if (attached.status !== 'active' || !attached.handle.settleForExport)
    throw new Error('missing settlement authority');
  const resourcePath = path.join(mkdtempForTestSync('settlement-progress-'), 'record.json');
  screenRecordingResourceStore.write(resourcePath, started.envelope);
  const readEnvelope = () => {
    const record = screenRecordingResourceStore.read(resourcePath);
    if (record.status !== 'decoded') throw new Error('missing recording');
    return record.envelope;
  };
  const progress = (): DurableCaptureProgress => ({
    learned: readEnvelope().metadata,
    record: (fact) => {
      const envelope = readEnvelope();
      screenRecordingResourceStore.write(resourcePath, {
        ...envelope,
        metadata: { ...envelope.metadata, ...fact },
      });
    },
  });
  return {
    runtime,
    started,
    settle: async () => await attached.handle.settleForExport!(progress()),
    finish: async () => {
      const reattached = await runtime.screenRecordingReattach({ envelope: readEnvelope() });
      if (reattached.status !== 'active') throw new Error('reattach failed');
      return await reattached.handle.finish(progress());
    },
    metadata: () => readEnvelope().metadata,
    progress,
    failAfterSignal: (value: 'throw' | 'uncertain') => {
      failAfterSignal = value;
    },
    loseAtStop: () => {
      loseAtStop = true;
    },
    files,
    signal,
    remove,
    removeManifest,
    finalize,
    manifest: () => manifest,
    setState: (next: typeof state) => {
      state = next;
    },
    replaceFence: () => {
      manifest = JSON.stringify({ ...JSON.parse(manifest), fenceToken: 'replacement' });
    },
  };
}

test('settles an owned recorder and preserves its marker and native output', async () => {
  const f = await setup();
  const manifest = f.manifest();
  const files = [...f.files];
  await expect(f.settle()).resolves.toEqual({ status: 'export' });
  expect(f.signal).toHaveBeenCalledOnce();
  expect([...f.files]).toEqual(files);
  expect(f.manifest()).toBe(manifest);
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.removeManifest).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
});

test('a gone recorder with material retains export authority without a signal', async () => {
  const f = await setup('missing');
  await expect(f.settle()).resolves.toEqual({ status: 'export' });
  expect(f.signal).not.toHaveBeenCalled();
  expect(f.files.size).toBe(1);
});

test.each(['process', 'fence'] as const)(
  'refuses lost %s authority without signalling or removing material',
  async (loss) => {
    const f = await setup();
    if (loss === 'process') f.setState('ownership-lost');
    else f.replaceFence();
    const marker = f.manifest();
    await expect(f.settle()).resolves.toEqual({
      status: 'retained',
      reason: 'ownership-fence-lost',
    });
    expect(f.signal).not.toHaveBeenCalled();
    expect(f.remove).not.toHaveBeenCalled();
    expect(f.removeManifest).not.toHaveBeenCalled();
    expect(f.files.size).toBe(1);
    expect(f.manifest()).toBe(marker);
  },
);

test('a failed stop retains material for a retry', async () => {
  const f = await setup();
  f.signal.mockRejectedValueOnce(new Error('stop failed'));
  const marker = f.manifest();
  await expect(f.settle()).resolves.toEqual({ status: 'retained', reason: 'stop-unconfirmed' });
  expect(f.files.size).toBe(1);
  expect(f.manifest()).toBe(marker);
  expect(f.remove).not.toHaveBeenCalled();
  await expect(f.settle()).resolves.toEqual({ status: 'export' });
});

test('missing native material is reported without discarding the marker', async () => {
  const f = await setup('missing');
  const marker = f.manifest();
  f.files.clear();
  await expect(f.settle()).resolves.toEqual({ status: 'retained', reason: 'resource-missing' });
  expect(f.signal).not.toHaveBeenCalled();
  expect(f.manifest()).toBe(marker);
  expect(f.removeManifest).not.toHaveBeenCalled();
});

test('transport detects a replaced owner during stop without signalling it', async () => {
  const f = await setup();
  const marker = f.manifest();
  f.loseAtStop();
  await expect(f.settle()).resolves.toEqual({ status: 'retained', reason: 'ownership-fence-lost' });
  expect(f.signal).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.removeManifest).not.toHaveBeenCalled();
  expect(f.files.size).toBe(1);
  expect(f.manifest()).toBe(marker);
  expect(f.metadata()?.stopObservation).toBeUndefined();
});

test('settlement journals an intentional stop for later reattachment and failed export retry', async () => {
  const f = await setup();
  await expect(f.settle()).resolves.toEqual({ status: 'export' });
  expect(f.metadata()).toMatchObject({
    stopObservation: { recorder: 'confirmed' },
    stoppedAtMs: expect.any(Number),
  });
  f.finalize.mockRejectedValueOnce(new Error('export failed'));
  await expect(f.finish()).rejects.toThrow('export failed');
  expect(f.files.size).toBe(1);
  const result = await f.finish();
  expect(result.status).toBe('completed');
  if (result.status === 'completed')
    expect(result.result.warning ?? '').not.toContain('180s platform limit');
  expect(f.signal).toHaveBeenCalledOnce();
});

test('a recorder already gone before settlement retains the natural limit warning', async () => {
  const f = await setup('missing');
  await expect(f.settle()).resolves.toEqual({ status: 'export' });
  expect(f.metadata()?.stopObservation).toBeUndefined();
  const result = await f.finish();
  expect(result.status).toBe('completed');
  if (result.status === 'completed') expect(result.result.warning).toContain('180s platform limit');
});

test('a missing chunk after a confirmed stop retains the stop checkpoint', async () => {
  const f = await setup();
  f.files.clear();
  await expect(f.settle()).resolves.toEqual({ status: 'retained', reason: 'resource-missing' });
  expect(f.metadata()).toMatchObject({ stopObservation: { recorder: 'confirmed' } });
  expect(f.removeManifest).not.toHaveBeenCalled();
});

test.each(['throw', 'uncertain'] as const)(
  'successful signal followed by %s probe remains intentional after reattach',
  async (failure) => {
    const f = await setup();
    f.failAfterSignal(failure);
    await expect(f.settle()).resolves.toMatchObject({ status: 'retained' });
    expect(f.metadata()).toMatchObject({
      activeRecorderSignal: { pid: '42', startTime: '1', remotePath: expect.any(String) },
    });
    expect(f.metadata()?.stopObservation).toBeUndefined();
    expect(f.files.size).toBe(1);
    f.finalize.mockRejectedValueOnce(new Error('retry export'));
    await expect(f.finish()).rejects.toThrow('retry export');
    const result = await f.finish();
    expect(result.status).toBe('completed');
    if (result.status === 'completed')
      expect(result.result.warning ?? '').not.toContain('180s platform limit');
    expect(f.signal).toHaveBeenCalledOnce();
  },
);

test('an older chunk stop failure preserves the active signal for the next stop', async () => {
  const f = await setup('owned-alive', true);
  await expect(f.settle()).resolves.toEqual({ status: 'retained', reason: 'stop-unconfirmed' });
  expect(f.metadata()).toMatchObject({ activeRecorderSignal: { pid: '42' } });
  expect(f.metadata()?.stopObservation).toBeUndefined();
  expect(f.files.size).toBe(2);
  const result = await f.finish();
  expect(result.status).toBe('completed');
  if (result.status === 'completed')
    expect(result.result.warning ?? '').not.toContain('180s platform limit');
  expect(f.signal).toHaveBeenCalledOnce();
});

test('a signal checkpoint for another recorder does not suppress the natural limit warning', async () => {
  const f = await setup('missing');
  f.progress().record({
    activeRecorderSignal: {
      pid: '99',
      startTime: '1',
      remotePath: '/sdcard/agent-device-recording-123.mp4',
    },
  });
  const result = await f.finish();
  expect(result.status).toBe('completed');
  if (result.status === 'completed') expect(result.result.warning).toContain('180s platform limit');
});

test('startup preservation fences and journals the real Android reattach without removing device material', async () => {
  const f = await setup();
  const sessionsDir = mkdtempForTestSync('startup-recording-preservation-');
  const resourcePath = screenRecordingResourceStore.resolvePath(path.join(sessionsDir, 'one'));
  screenRecordingResourceStore.write(resourcePath, f.started.envelope);
  const marker = f.manifest();
  const material = [...f.files];
  const dispose = vi.fn(async () => {});
  const gateway = {
    bind: async ({ device }: { device: unknown }) => ({
      device,
      owner: localRuntimeOwner('android'),
      facts: {
        device: { family: 'android', kind: 'emulator', providerMode: 'local' },
        operations: {
          screenRecordingReattach: { available: true },
          screenRecordingCleanup: { available: true },
        },
      },
      operations: f.runtime,
      [Symbol.asyncDispose]: dispose,
    }),
  } as unknown as DeviceRuntimeGateway<PlatformRuntimeOperations>;
  const outcome = await recoverScreenRecordingResourceAfterDaemonLock({
    sessionsDir,
    resourcePath,
    gateway,
    claim: { sessionId: f.started.envelope.sessionId, device: f.started.envelope.device },
    scope: {
      signal: new AbortController().signal,
      diagnostics: { emit: () => {} },
      progress: { report: () => {} },
    },
  });
  expect(outcome).toEqual({ status: 'retained', reason: 'export-pending' });
  expect(f.signal).toHaveBeenCalledOnce();
  expect(f.manifest()).toBe(marker);
  expect([...f.files]).toEqual(material);
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.removeManifest).not.toHaveBeenCalled();
  expect(f.finalize).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(screenRecordingResourceStore.read(resourcePath)).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'open',
      metadata: { activeRecorderSignal: { pid: '42' }, stopObservation: { recorder: 'confirmed' } },
    },
  });
});
