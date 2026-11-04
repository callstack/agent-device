import { expect, test } from 'vitest';
import { ScreenRecordingStartRolledBack } from '@agent-device/contracts/screen-recording-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  androidRecordingDevice,
  recordingHost,
  recordingInput,
  recordingProcess,
} from './fixtures.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';
import { AndroidScreenRecordingStartRollbackUnconfirmed } from './chunks.ts';

const start = async (overrides: Record<string, unknown>, signal = new AbortController().signal) =>
  await bindAndroidScreenRecordingRuntime({
    host: recordingHost(overrides),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal,
  });

test('cancellation during active manifest publication retires evidence after confirmed rollback', async () => {
  const controller = new AbortController();
  const reason = new Error('recording canceled during active manifest publication');
  const calls: string[] = [];
  let manifest = '';
  let writes = 0;
  const runtime = await start(
    {
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
        writes += 1;
        if (writes === 3) {
          controller.abort(reason);
          throw reason;
        }
      },
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      removeManifest: async () => {
        calls.push('remove-manifest');
        manifest = '';
        return true;
      },
      stop: async ({ pid }: { pid: string }) => {
        calls.push(`signal:${pid}`);
        return 'already-missing' as const;
      },
      remove: async () => {
        calls.push('remove-artifact');
        return true;
      },
    },
    controller.signal,
  );

  await expect(runtime.screenRecordingStart(recordingInput())).rejects.toBeInstanceOf(
    ScreenRecordingStartRolledBack,
  );
  expect(calls).toEqual(['signal:42', 'remove-artifact', 'remove-manifest']);
  expect(manifest).toBe('');

  const replacement = await start({
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
  });
  await expect(replacement.screenRecordingStart(recordingInput())).resolves.toMatchObject({
    envelope: expect.any(Object),
  });
  expect(manifest).not.toBe('');
});

test('cancellation during active manifest publication retains evidence after uncertain rollback', async () => {
  const controller = new AbortController();
  const reason = new Error('recording canceled with uncertain active cleanup');
  let manifest = '';
  let writes = 0;
  let removals = 0;
  const runtime = await start(
    {
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
        writes += 1;
        if (writes === 3) {
          controller.abort(reason);
          throw reason;
        }
      },
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      stop: async () => 'ownership-lost' as const,
      remove: async () => {
        removals += 1;
        return true;
      },
    },
    controller.signal,
  );

  await expect(runtime.screenRecordingStart(recordingInput())).rejects.toBeInstanceOf(
    AndroidScreenRecordingStartRollbackUnconfirmed,
  );
  expect(JSON.parse(manifest).chunks).toMatchObject([{ remotePid: '42' }]);
  expect(removals).toBe(0);

  const replacement = await start({
    readManifest: async () => ({ status: 'read' as const, contents: manifest }),
    start: async () => recordingProcess('43'),
  });
  await expect(replacement.screenRecordingStart(recordingInput())).rejects.toBeInstanceOf(
    AndroidScreenRecordingStartRollbackUnconfirmed,
  );
});

test('live cleanup refuses a replacement marker with a different claim token', async () => {
  let manifest = '';
  const signals: string[] = [];
  const runtime = await start({
    readManifest: async (path: string) =>
      path.startsWith('/sdcard') && manifest
        ? { status: 'read' as const, contents: manifest }
        : { status: 'missing' as const },
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    stop: async ({ pid }: { pid: string }) => {
      signals.push(pid);
      return 'stopped' as const;
    },
  });
  const started = await runtime.screenRecordingStart({
    ...recordingInput(),
    claimToken: 'claim-one',
  });
  manifest = JSON.stringify({ ...JSON.parse(manifest), claimToken: 'claim-successor' });
  const replacement = manifest;
  await expect(started.pendingHandle.transfer().forceCleanup()).resolves.toMatchObject({
    status: 'cleanup-pending',
    reason: 'ownership-fence-lost',
  });
  expect(signals).toEqual([]);
  expect(manifest).toBe(replacement);
});
