import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

async function setup(initial: 'owned-alive' | 'missing' = 'owned-alive') {
  let manifest = '';
  let state: 'owned-alive' | 'missing' | 'ownership-lost' = initial;
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
      inspect: async () => state,
      stop: async () => (state === 'missing' ? ('already-missing' as const) : await signal()),
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
  const attached = await runtime.screenRecordingReattach({ envelope: started.envelope });
  if (attached.status !== 'active' || !attached.handle.settleForExport)
    throw new Error('missing settlement authority');
  return {
    settle: attached.handle.settleForExport,
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
