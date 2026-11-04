import assert from 'node:assert/strict';
import { expect, test, vi } from 'vitest';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import {
  androidRecordingDevice,
  recordingHost,
  recordingInput,
  recordingProcess,
} from './fixtures.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

const start = async (overrides: Record<string, unknown>) =>
  await bindAndroidScreenRecordingRuntime({
    host: recordingHost(overrides),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });

test('persists durable fence evidence and finishes through the scoped Android transport', async () => {
  let manifest = '';
  const calls: string[] = [];
  const runtime = await start({
    start: async ({ remotePath }: { remotePath: string }) => {
      calls.push(`start:${remotePath}`);
      return recordingProcess('42');
    },
    pull: async ({ remotePath, outputPath }: { remotePath: string; outputPath: string }) => {
      calls.push(`pull:${remotePath}:${outputPath}`);
      return { stdout: '', stderr: '', exitCode: 0 };
    },
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
      calls.push(JSON.parse(contents).completion ? 'completed-evidence' : 'active-evidence');
    },
    removeManifest: async () => {
      manifest = '';
      return true;
    },
    remove: async (remotePath: string) => {
      calls.push(`remove:${remotePath}`);
      return true;
    },
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  assert.match(manifest, /"fenceToken":"fence-1"/);
  assert.match(manifest, /"fenceGeneration":2/);
  await expect(started.pendingHandle.transfer().finish()).resolves.toMatchObject({
    status: 'completed',
  });
  expect(calls.filter((call) => call.startsWith('pull:'))).toHaveLength(1);
  expect(JSON.parse(manifest)).toMatchObject({ completion: { outPath: '/tmp/capture.mp4' } });
  expect(calls.indexOf('completed-evidence')).toBeLessThan(
    calls.findIndex((call) => call.startsWith('remove:')),
  );
});

test('does not remove native evidence when bounded playable pulls are exhausted', async () => {
  vi.useFakeTimers();
  try {
    let manifest = '';
    const removed: string[] = [];
    const runtime = await start({
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
      pullPlayable: async () => ({ stdout: '', stderr: '', exitCode: 0, playable: false }),
      remove: async (remotePath: string) => {
        removed.push(remotePath);
        return true;
      },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    const finishing = handle.finish();
    const rejected = expect(finishing).rejects.toThrow('playable Android recording');
    await vi.advanceTimersByTimeAsync(3_000);
    await rejected;
    expect(removed).toEqual([]);
    expect(JSON.parse(manifest)).not.toHaveProperty('completion');
  } finally {
    vi.useRealTimers();
  }
});

test('waits for a SIGINT-accepted recorder to exit before sizing or pulling its artifact', async () => {
  vi.useFakeTimers();
  try {
    let alive = true;
    const calls: string[] = [];
    const runtime = await start({
      stop: async () => {
        calls.push('sigint');
        return 'stopped' as const;
      },
      inspect: async () => (alive ? ('owned-alive' as const) : ('missing' as const)),
      size: async () => {
        calls.push('size');
        return 1;
      },
      pullPlayable: async () => {
        calls.push('pull');
        return { stdout: '', stderr: '', exitCode: 0, playable: true };
      },
    });
    const finishing = (await runtime.screenRecordingStart(recordingInput())).pendingHandle
      .transfer()
      .finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toEqual(['sigint']);
    alive = false;
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(finishing).resolves.toMatchObject({ status: 'completed' });
    expect(calls).toEqual(['sigint', 'size', 'size', 'pull']);
  } finally {
    vi.useRealTimers();
  }
});

test('retains native evidence when finalization fails and cleans it only on requested disposal', async () => {
  const calls: string[] = [];
  const stopped = new Set<string>();
  let manifest = '';
  const host = recordingHost({
    signal: async ({ pid }: { pid: string }) => {
      calls.push(`signal:${pid}`);
      stopped.add(pid);
      return true;
    },
    isRunning: async (pid: string) => !stopped.has(pid),
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    remove: async (path: string) => {
      calls.push(`remove:${path}`);
      return true;
    },
    removeManifest: async (path: string) => {
      calls.push(`manifest:${path}`);
      return true;
    },
  });
  (host.screenRecording.finalize as unknown as { complete: () => Promise<never> }).complete =
    async () => {
      throw new Error('finalizer failed');
    };
  const runtime = await bindAndroidScreenRecordingRuntime({
    host,
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });
  const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
  await expect(handle.finish()).rejects.toThrow('finalizer failed');
  await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });
  expect(calls).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^signal:/),
      expect.stringMatching(/^remove:/),
      expect.stringMatching(/^manifest:/),
    ]),
  );
});

test('serializes a failed rotation so finish cannot publish completion', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const runtime = await start({
      start: async () => {
        starts += 1;
        if (starts > 1) throw new Error('rotation start failed');
        return recordingProcess('42');
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
    });
    const started = await runtime.screenRecordingStart(recordingInput());
    await vi.advanceTimersByTimeAsync(170_000);
    expect(JSON.parse(manifest)).toMatchObject({ chunks: [{ remotePid: '42' }] });
    expect(JSON.parse(manifest)).toHaveProperty('pendingRemotePath');
    await expect(started.pendingHandle.transfer().finish()).rejects.toThrow(
      'rollback could not be confirmed',
    );
  } finally {
    vi.useRealTimers();
  }
});

/**
 * Holds the manifest write that would commit the second chunk, standing in for the transport's
 * `printf %s … > tmp && mv -f tmp manifest`, which publishes on the device only once its command
 * finishes. Aborting the host command cannot undo that rename or prove it never ran.
 */
function pauseChunkCommit() {
  let paused = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    intercept: async (contents: string) => {
      if (paused) return;
      const written = JSON.parse(contents) as { chunks?: unknown[] };
      if (written.chunks?.length !== 2) return;
      paused = true;
      await released;
    },
    isPaused: () => paused,
    release: () => release(),
  };
}

/**
 * Holds the manifest write that names the next chunk as pending, before any recorder for it is
 * launched, so a stop can be claimed between the marker reaching the device and the launch.
 */
function pausePendingEvidence() {
  let paused = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    intercept: async (contents: string) => {
      if (paused) return;
      const written = JSON.parse(contents) as { chunks?: unknown[]; pendingRemotePath?: string };
      if (written.chunks?.length !== 1 || written.pendingRemotePath === undefined) return;
      paused = true;
      await released;
    },
    isPaused: () => paused,
    release: () => release(),
  };
}

/** Holds the graceful stop of the recorder a sequential rotation is retiring. */
function pauseChunkRetirement(pid: string) {
  let paused = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    intercept: async (stoppedPid: string) => {
      if (stoppedPid !== pid || paused) return;
      paused = true;
      await released;
    },
    isPaused: () => paused,
    release: () => release(),
  };
}

/** Pauses the launch of the next chunk, so a stop can be claimed before that child is reported. */
function pauseNextLaunch() {
  let paused = false;
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    intercept: async () => {
      paused = true;
      await released;
    },
    isWaiting: () => paused,
    release: () => release(),
  };
}

test('does not start a chunk after finish when a successful rotation is still in flight', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const commit = pauseChunkCommit();
    const runtime = await start({
      start: async () => {
        starts += 1;
        return recordingProcess(String(41 + starts));
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
        await commit.intercept(contents);
      },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(starts).toBe(2);
    expect(commit.isPaused()).toBe(true);
    const finishing = handle.finish();
    commit.release();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(finishing).resolves.toMatchObject({ status: 'completed' });
    await vi.advanceTimersByTimeAsync(170_000);
    expect(starts).toBe(2);
    expect(JSON.parse(manifest)).toMatchObject({
      chunks: [{ remotePid: '42' }, { remotePid: '43' }],
    });
  } finally {
    vi.useRealTimers();
  }
});

test('does not start a chunk after force cleanup when a successful rotation is still in flight', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const commit = pauseChunkCommit();
    const stopped = new Set<string>();
    const runtime = await start({
      start: async () => {
        starts += 1;
        return recordingProcess(String(41 + starts));
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
        await commit.intercept(contents);
      },
      stop: async ({ pid }: { pid: string }) => {
        if (stopped.has(pid)) return 'already-missing' as const;
        stopped.add(pid);
        return 'stopped' as const;
      },
      inspect: async ({ pid }: { pid: string }) =>
        stopped.has(pid) ? ('missing' as const) : ('owned-alive' as const),
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      removeManifest: async () => {
        manifest = '';
        return true;
      },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(starts).toBe(2);
    expect(commit.isPaused()).toBe(true);
    const cleaning = handle.forceCleanup();
    commit.release();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(cleaning).resolves.toEqual({ status: 'cleaned' });
    await vi.advanceTimersByTimeAsync(170_000);
    expect(starts).toBe(2);
    // The rotation's recorder was signaled whichever way its commit settled: adopted then cleaned, or
    // refused then rolled back. Either way no recorder outlives the cleanup.
    expect(stopped).toEqual(new Set(['42', '43']));
    expect(manifest).toBe('');
  } finally {
    vi.useRealTimers();
  }
});

test('rolls back the chunk a rotation launched after the stop was claimed', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const launch = pauseNextLaunch();
    const startedPaths: string[] = [];
    const removed: string[] = [];
    const stopped = new Set<string>();
    const runtime = await start({
      start: async ({ remotePath }: { remotePath: string }) => {
        starts += 1;
        if (starts > 1) await launch.intercept();
        startedPaths.push(remotePath);
        return recordingProcess(String(41 + starts));
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
      stop: async ({ pid }: { pid: string }) => {
        if (stopped.has(pid)) return 'already-missing' as const;
        stopped.add(pid);
        return 'stopped' as const;
      },
      inspect: async ({ pid }: { pid: string }) =>
        stopped.has(pid) ? ('missing' as const) : ('owned-alive' as const),
      remove: async (remotePath: string) => {
        removed.push(remotePath);
        return true;
      },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(launch.isWaiting()).toBe(true);
    const finishing = handle.finish();
    launch.release();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(finishing).resolves.toMatchObject({ status: 'completed' });
    expect(starts).toBe(2);
    expect(stopped).toEqual(new Set(['42', '43']));
    expect(removed).toContain(startedPaths[1]);
    expect(JSON.parse(manifest).chunks).toHaveLength(1);
  } finally {
    vi.useRealTimers();
  }
});

test('does not launch the sequential fallback after the stop was claimed', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const retirement = pauseChunkRetirement('42');
    const stopped = new Set<string>();
    const runtime = await start({
      start: async () => {
        starts += 1;
        return recordingProcess(String(41 + starts));
      },
      exists: async (remotePath: string) =>
        starts === 1 || !remotePath.includes('agent-device-recording-'),
      stop: async ({ pid }: { pid: string }) => {
        if (pid !== '42') return 'already-missing' as const;
        await retirement.intercept(pid);
        if (stopped.has(pid)) return 'already-missing' as const;
        stopped.add(pid);
        return 'stopped' as const;
      },
      inspect: async ({ pid }: { pid: string }) =>
        pid !== '42' || stopped.has(pid) ? ('missing' as const) : ('owned-alive' as const),
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(starts).toBe(2);
    expect(retirement.isPaused()).toBe(true);
    const finishing = handle.finish();
    retirement.release();
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await finishing;
    expect(outcome).toMatchObject({ status: 'completed' });
    // The rotation retired this recorder itself, so its absence is not the 180 s platform limit.
    expect((outcome as { result?: { warning?: string } }).result?.warning ?? '').not.toMatch(
      /platform limit/,
    );
    expect(starts).toBe(2);
    expect(JSON.parse(manifest).chunks).toEqual([expect.objectContaining({ remotePid: '42' })]);
  } finally {
    vi.useRealTimers();
  }
});

test('still discloses the platform limit when the recorder a fallback retired had already exited', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const retirement = pauseChunkRetirement('42');
    const runtime = await start({
      start: async () => {
        starts += 1;
        return recordingProcess(String(41 + starts));
      },
      // The platform's 180 s cap ended this recorder just before the rotation reached it, so the
      // retirement is told the recorder was already gone rather than confirming a stop of its own.
      exists: async (remotePath: string) =>
        starts === 1 || !remotePath.includes('agent-device-recording-'),
      stop: async ({ pid }: { pid: string }) => {
        if (pid !== '42') return 'already-missing' as const;
        await retirement.intercept(pid);
        return 'already-missing' as const;
      },
      inspect: async () => 'missing' as const,
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(starts).toBe(2);
    expect(retirement.isPaused()).toBe(true);
    const finishing = handle.finish();
    retirement.release();
    await vi.advanceTimersByTimeAsync(5_000);
    const outcome = await finishing;
    expect(outcome).toMatchObject({ status: 'completed' });
    // The recorder died of the platform limit before the retirement ran, so that disclosure must
    // survive the rotation that tried to retire it.
    expect((outcome as { result?: { warning?: string } }).result?.warning ?? '').toMatch(
      /platform limit/,
    );
    expect(starts).toBe(2);
    expect(JSON.parse(manifest).chunks).toEqual([expect.objectContaining({ remotePid: '42' })]);
  } finally {
    vi.useRealTimers();
  }
});

test('does not dispatch a chunk launch whose pending evidence was written after the stop was claimed', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const pending = pausePendingEvidence();
    const runtime = await start({
      start: async () => {
        starts += 1;
        return recordingProcess(String(41 + starts));
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
        await pending.intercept(contents);
      },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(pending.isPaused()).toBe(true);
    const finishing = handle.finish();
    pending.release();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(finishing).resolves.toMatchObject({ status: 'completed' });
    expect(starts).toBe(1);
    // The refusal clears the pending marker through the normal rollback, so the device is never left
    // naming a recorder nothing launched.
    expect(JSON.parse(manifest)).toEqual(
      expect.objectContaining({ chunks: [expect.objectContaining({ remotePid: '42' })] }),
    );
    expect(JSON.parse(manifest)).not.toHaveProperty('pendingRemotePath');
  } finally {
    vi.useRealTimers();
  }
});

test('collects a chunk whose commit published while the stop was in flight', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    // What the device's marker actually holds. A publication runs `printf %s … > tmp && mv -f tmp
    // manifest`: the rename commits the marker on the device while the host command is still running,
    // and aborting that command would make the host reject even though the rename already happened.
    // The commit therefore takes no stop signal at all, and this mock holds that write in flight
    // across the stop to show its real outcome decides what the recording keeps.
    const deviceWrites: string[] = [];
    const commit = pauseChunkCommit();
    const startedPaths: string[] = [];
    const pulled: string[] = [];
    const stopped = new Set<string>();
    const runtime = await start({
      start: async ({ remotePath }: { remotePath: string }) => {
        starts += 1;
        startedPaths.push(remotePath);
        return recordingProcess(String(41 + starts));
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        await commit.intercept(contents);
        deviceWrites.push(contents);
      },
      stop: async ({ pid }: { pid: string }) => {
        if (stopped.has(pid)) return 'already-missing' as const;
        stopped.add(pid);
        return 'stopped' as const;
      },
      inspect: async ({ pid }: { pid: string }) =>
        stopped.has(pid) ? ('missing' as const) : ('owned-alive' as const),
      pullPlayable: async ({ remotePath }: { remotePath: string }) => {
        pulled.push(remotePath);
        return { stdout: '', stderr: '', exitCode: 0, playable: true };
      },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(starts).toBe(2);
    expect(commit.isPaused()).toBe(true);
    const finishing = handle.finish();
    commit.release();
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(finishing).resolves.toMatchObject({ status: 'completed' });
    // The rename committed the chunk on the device while the stop was in flight, so the recording
    // keeps it: finish collects both chunks and stops both recorders.
    expect(pulled).toEqual([startedPaths[0], startedPaths[1]]);
    expect(stopped).toEqual(new Set(['42', '43']));
    const finalMarker = JSON.parse(deviceWrites.at(-1)!);
    expect(finalMarker.chunks).toEqual([
      expect.objectContaining({ remotePid: '42' }),
      expect.objectContaining({ remotePid: '43' }),
    ]);
    expect(finalMarker).not.toHaveProperty('pendingRemotePath');
    expect(finalMarker).toHaveProperty('completion');
  } finally {
    vi.useRealTimers();
  }
});

test('retains the child when the rotation commit fails after the stop was claimed', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const commit = pauseChunkCommit();
    const startedPaths: string[] = [];
    const stopped = new Set<string>();
    const runtime = await start({
      start: async ({ remotePath }: { remotePath: string }) => {
        starts += 1;
        startedPaths.push(remotePath);
        return recordingProcess(String(41 + starts));
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        await commit.intercept(contents);
        // The commit itself fails: a real write failure, not a stop refusing it.
        if ((JSON.parse(contents) as { chunks: unknown[] }).chunks.length === 2)
          throw new Error('rotation manifest failed');
        manifest = contents;
      },
      stop: async ({ pid }: { pid: string }) => {
        // The child's recorder cannot be confirmed gone, so its rollback stays unconfirmed.
        if (pid === '43') return 'uncertain' as const;
        if (stopped.has(pid)) return 'already-missing' as const;
        stopped.add(pid);
        return 'stopped' as const;
      },
      inspect: async ({ pid }: { pid: string }) =>
        pid === '43' || !stopped.has(pid) ? ('owned-alive' as const) : ('missing' as const),
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(starts).toBe(2);
    expect(commit.isPaused()).toBe(true);
    const finishing = handle.finish();
    const refused = expect(finishing).rejects.toThrow('rotation manifest failed');
    commit.release();
    await vi.advanceTimersByTimeAsync(20_000);
    // A failed commit is a rotation failure even after a claimed stop: finish cannot report success
    // while the child's recorder is unaccounted for.
    await refused;
    // The unconfirmed child stays in the recovery evidence as pending, so disposal can settle it.
    const marker = JSON.parse(manifest);
    expect(marker.chunks).toEqual([expect.objectContaining({ remotePid: '42' })]);
    expect(marker).toMatchObject({ pendingRemotePath: startedPaths[1] });
    const cleaning = handle.forceCleanup();
    const pending = expect(cleaning).resolves.toMatchObject({ status: 'cleanup-pending' });
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(manifest).not.toBe('');
  } finally {
    vi.useRealTimers();
  }
});

test('retains the child when its artifact removal fails after the stop was claimed', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const commit = pauseChunkCommit();
    const startedPaths: string[] = [];
    const stopped = new Set<string>();
    const runtime = await start({
      start: async ({ remotePath }: { remotePath: string }) => {
        starts += 1;
        startedPaths.push(remotePath);
        return recordingProcess(String(41 + starts));
      },
      writeManifest: async ({ contents }: { contents: string }) => {
        await commit.intercept(contents);
        if ((JSON.parse(contents) as { chunks: unknown[] }).chunks.length === 2)
          throw new Error('rotation manifest failed');
        manifest = contents;
      },
      stop: async ({ pid }: { pid: string }) => {
        if (stopped.has(pid)) return 'already-missing' as const;
        stopped.add(pid);
        return 'stopped' as const;
      },
      inspect: async ({ pid }: { pid: string }) =>
        stopped.has(pid) ? ('missing' as const) : ('owned-alive' as const),
      // The recorder is gone but the device will not give the file back, so the rollback stays
      // unconfirmed and the file keeps its name in the evidence.
      remove: async (remotePath: string) => remotePath !== startedPaths[1],
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(commit.isPaused()).toBe(true);
    const finishing = handle.finish();
    const refused = expect(finishing).rejects.toThrow('rotation manifest failed');
    commit.release();
    await vi.advanceTimersByTimeAsync(20_000);
    await refused;
    const marker = JSON.parse(manifest);
    expect(marker.chunks).toEqual([expect.objectContaining({ remotePid: '42' })]);
    expect(marker).toMatchObject({ pendingRemotePath: startedPaths[1] });
    expect(stopped.has('43')).toBe(true);
    // Disposal re-attempts the file the device still holds and stays pending while it cannot.
    const cleaning = handle.forceCleanup();
    const pending = expect(cleaning).resolves.toMatchObject({ status: 'cleanup-pending' });
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    expect(manifest).not.toBe('');
  } finally {
    vi.useRealTimers();
  }
});

test('falls back to sequential rotation when concurrent start is unavailable', async () => {
  vi.useFakeTimers();
  try {
    let starts = 0;
    let manifest = '';
    const runtime = await start({
      start: async () => {
        starts += 1;
        return recordingProcess(String(41 + starts));
      },
      exists: async () => starts === 1 || starts > 2,
      inspect: async ({ pid }: { pid: string }) =>
        pid === '42' || Number(pid) > 43 ? ('owned-alive' as const) : ('missing' as const),
      stop: async () => 'already-missing' as const,
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
    });
    await runtime.screenRecordingStart(recordingInput());
    await vi.advanceTimersByTimeAsync(170_000);
    expect(starts).toBe(3);
    expect(JSON.parse(manifest).chunks).toHaveLength(2);
  } finally {
    vi.useRealTimers();
  }
});

test('rolls back a failed concurrent rotation commit and restores prior active evidence', async () => {
  vi.useFakeTimers();
  try {
    let writes = 0;
    let starts = 0;
    let manifest = '';
    const stopped = new Set<string>();
    const runtime = await start({
      start: async () => recordingProcess(String(42 + starts++)),
      writeManifest: async ({ contents }: { contents: string }) => {
        writes += 1;
        if (writes === 6) throw new Error('rotation manifest failed');
        manifest = contents;
      },
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      signal: async ({ pid }: { pid: string }) => {
        stopped.add(pid);
        return true;
      },
      isRunning: async (pid: string) => !stopped.has(pid),
    });
    const handle = (await runtime.screenRecordingStart(recordingInput())).pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(JSON.parse(manifest)).toMatchObject({ chunks: [{ remotePid: '42' }] });
    expect(JSON.parse(manifest)).not.toHaveProperty('pendingRemotePath');
    await expect(handle.finish()).rejects.toThrow('rotation manifest failed');
    await expect(handle.forceCleanup()).resolves.toEqual({ status: 'cleaned' });
    expect(stopped).toEqual(new Set(['42', '43']));
  } finally {
    vi.useRealTimers();
  }
});
