import { expect, test, vi } from 'vitest';
import { cleanupVerifiedAndroidEvidence } from './cleanup.ts';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { createNativeManifest, type NativeChunk, type NativeManifest } from './manifest.ts';

const recordedChunk: NativeChunk = {
  index: 1,
  remotePath: '/sdcard/agent-device-recording-1.mp4',
  remotePid: '42',
  remoteStartTime: '7',
};

const manifestPath = '/sdcard/agent-device-recording-active.json';

function evidence(chunks: readonly NativeChunk[]): NativeManifest {
  return createNativeManifest(
    androidRecordingDevice,
    recordingInput(),
    1,
    chunks,
    undefined,
    'local',
  );
}

async function testTransport(overrides: Record<string, unknown>) {
  return await recordingHost(overrides).screenRecording.android.resolve(androidRecordingDevice);
}

function cleaned(transport: Awaited<ReturnType<typeof testTransport>>) {
  return cleanupVerifiedAndroidEvidence(transport, evidence([recordedChunk]), manifestPath);
}

test('attempts every fenced native chunk before retaining cleanup evidence', async () => {
  const attempts: string[] = [];
  const transport = await testTransport({
    stop: async ({ pid }: { pid: string }) => {
      attempts.push(`stop:${pid}`);
      if (pid === '41') throw new Error('stop failed');
      return 'stopped' as const;
    },
    inspect: async () => 'missing' as const,
    remove: async (remotePath: string) => {
      attempts.push(`remove:${remotePath}`);
      return true;
    },
  });
  const transportEvidence = evidence([
    { ...recordedChunk, remotePid: '41' },
    { ...recordedChunk, index: 2, remotePath: '/sdcard/agent-device-recording-2.mp4' },
  ]);
  await expect(
    cleanupVerifiedAndroidEvidence(transport, transportEvidence, manifestPath),
  ).resolves.toMatchObject({ status: 'cleanup-pending' });
  expect(attempts).toContain('stop:42');
  expect(attempts).toContain('stop:41');
});

test('cleans evidence whose pid Android reassigned once a conclusive scan finds no writer', async () => {
  const stops: Array<{ pid: string; force?: boolean }> = [];
  const removed: string[] = [];
  const markers: string[] = [];
  const transport = await testTransport({
    inspect: async () => 'ownership-lost' as const,
    stop: async (
      { pid }: { pid: string },
      options?: Readonly<{ force?: boolean }>,
    ): Promise<'stopped'> => {
      stops.push({ pid, force: options?.force });
      return 'stopped';
    },
    findRunning: async () => ({ writers: [], conclusive: true }),
    remove: async (remotePath: string) => {
      removed.push(remotePath);
      return true;
    },
    removeManifest: async (manifestPath: string) => {
      markers.push(manifestPath);
      return true;
    },
  });
  await expect(cleaned(transport)).resolves.toEqual({ status: 'cleaned' });
  // The pid now names an unrelated process, so it is never a stop target.
  expect(stops).toEqual([]);
  expect(removed).toEqual([recordedChunk.remotePath]);
  expect(markers).toEqual([manifestPath]);
});

test.each([
  ['an inconclusive scan', { writers: [], conclusive: false }],
  [
    'a foreign writer on the recorded path',
    {
      writers: [{ pid: '77', remotePath: recordedChunk.remotePath, startTime: '99' }],
      conclusive: true,
    },
  ],
] as const)(
  'retains evidence whose reassigned pid path reports %s',
  async (_name, scan: { writers: readonly unknown[]; conclusive: boolean }) => {
    const stops: string[] = [];
    const removed: string[] = [];
    let marker = JSON.stringify(evidence([recordedChunk]));
    const transport = await testTransport({
      inspect: async () => 'ownership-lost' as const,
      stop: async ({ pid }: { pid: string }) => {
        stops.push(pid);
        return 'stopped' as const;
      },
      findRunning: async () => scan,
      remove: async (remotePath: string) => {
        removed.push(remotePath);
        return true;
      },
      removeManifest: async () => {
        marker = '';
        return true;
      },
    });
    await expect(cleaned(transport)).resolves.toMatchObject({
      status: 'cleanup-pending',
      reason: 'transport-failed',
    });
    expect(stops).toEqual([]);
    expect(removed).toEqual([]);
    expect(marker).not.toBe('');
  },
);

test('stops a recorder that still owns its pid without scanning the artifact path', async () => {
  vi.useFakeTimers();
  try {
    const stops: Array<{ pid: string; force?: boolean }> = [];
    let scans = 0;
    const transport = await testTransport({
      inspect: async () => 'owned-alive' as const,
      stop: async (
        { pid }: { pid: string },
        options?: Readonly<{ force?: boolean }>,
      ): Promise<'stopped'> => {
        stops.push({ pid, force: options?.force });
        return 'stopped';
      },
      findRunning: async () => {
        scans += 1;
        return { writers: [], conclusive: true };
      },
    });
    const cleaning = cleaned(transport);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(cleaning).resolves.toEqual({ status: 'cleaned' });
    expect(stops).toEqual([
      { pid: '42', force: undefined },
      { pid: '42', force: true },
    ]);
    expect(scans).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

test('stops the live chunk of a two-chunk recording whose other chunk reports a reused pid', async () => {
  // Both chunks write one path, so the shared path is only free once the live recorder is stopped.
  const calls: string[] = [];
  const stopped = new Set<string>();
  const twoChunks = [
    { ...recordedChunk, remotePid: '41' },
    { ...recordedChunk, index: 2, remotePid: '42' },
  ];
  const transport = await testTransport({
    inspect: async ({ pid }: { pid: string }) => {
      calls.push(`inspect:${pid}`);
      if (pid === '41') return 'ownership-lost' as const;
      return stopped.has(pid) ? ('missing' as const) : ('owned-alive' as const);
    },
    stop: async ({ pid }: { pid: string }) => {
      calls.push(`stop:${pid}`);
      stopped.add(pid);
      return 'stopped' as const;
    },
    findRunning: async () => {
      calls.push('scan');
      // The reused pid belongs to an unrelated process; only this recording's own recorder writes.
      return stopped.has('42')
        ? { writers: [], conclusive: true }
        : {
            writers: [{ pid: '42', remotePath: recordedChunk.remotePath, startTime: '7' }],
            conclusive: true,
          };
    },
    remove: async () => true,
    removeManifest: async () => true,
  });
  await expect(
    cleanupVerifiedAndroidEvidence(transport, evidence(twoChunks), manifestPath),
  ).resolves.toEqual({ status: 'cleaned' });
  // The reused pid is never signalled, and the scan only proves the path free after the stop.
  expect(calls.filter((call) => call === 'stop:41')).toEqual([]);
  expect(calls.indexOf('stop:42')).toBeLessThan(calls.indexOf('scan'));
});

test('stops the live chunk before retaining a two-chunk recording whose reused pid scan is inconclusive', async () => {
  const calls: string[] = [];
  const transport = await testTransport({
    inspect: async ({ pid }: { pid: string }) =>
      pid === '41' ? ('ownership-lost' as const) : ('missing' as const),
    stop: async ({ pid }: { pid: string }) => {
      calls.push(`stop:${pid}`);
      return 'already-missing' as const;
    },
    findRunning: async () => {
      calls.push('scan');
      return { writers: [], conclusive: false };
    },
    remove: async () => {
      calls.push('remove');
      return true;
    },
  });
  await expect(
    cleanupVerifiedAndroidEvidence(
      transport,
      evidence([
        { ...recordedChunk, remotePid: '41' },
        { ...recordedChunk, index: 2, remotePath: '/sdcard/agent-device-recording-2.mp4' },
      ]),
      manifestPath,
    ),
  ).resolves.toMatchObject({ status: 'cleanup-pending', reason: 'transport-failed' });
  expect(calls).toEqual(['stop:42', 'scan']);
});
