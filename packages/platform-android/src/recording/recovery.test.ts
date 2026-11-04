import { expect, test } from 'vitest';
import { isScreenRecordingStartNotDispatched } from '@agent-device/contracts/screen-recording-runtime';
import { localRuntimeOwner } from '@agent-device/contracts/platform-runtime';
import { androidRecordingDevice, recordingHost, recordingInput } from './fixtures.ts';
import { recordingArtifactPath, recordingMarkerPath } from './native-path.ts';
import { bindAndroidScreenRecordingRuntime } from './runtime.ts';

const start = async (overrides: Record<string, unknown>) =>
  await bindAndroidScreenRecordingRuntime({
    host: recordingHost(overrides),
    device: androidRecordingDevice,
    owner: localRuntimeOwner('android'),
    signal: new AbortController().signal,
  });

test('reattaches complete matching evidence and refuses fence, session, or device changes', async () => {
  let manifest = '';
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
  });
  const started = await runtime.screenRecordingStart({
    ...recordingInput(),
    outputPath: '/tmp/manifest-name.mp4',
    clientOutputPath: '/client/manifest-name.mp4',
    scope: 'system',
    recordOnlySession: true,
    activeSessionApp: { bundleId: 'com.example.app', name: 'Example' },
    exportQuality: 'high',
    fps: 15,
  });
  const active = await runtime.screenRecordingReattach({ envelope: started.envelope });
  expect(active.status).toBe('active');
  if (active.status === 'active')
    expect(active.handle.inspect()).toMatchObject({
      outPath: '/tmp/manifest-name.mp4',
      clientOutPath: '/client/manifest-name.mp4',
      scope: 'system',
      recordOnlySession: true,
      exportQuality: 'high',
      fps: 15,
    });
  for (const envelope of [
    { ...started.envelope, fence: { token: 'other', generation: 2 } },
    { ...started.envelope, sessionId: 'other-session' },
    { ...started.envelope, device: { ...started.envelope.device, id: 'other-device' } },
  ]) {
    await expect(runtime.screenRecordingReattach({ envelope })).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'ownership-fence-lost',
    });
  }
});

test('reattaches an ended pid with an artifact as finishable recovery and reports the 180s warning', async () => {
  let manifest = '';
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    isRunning: async () => false,
    exists: async () => true,
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  const reattached = await runtime.screenRecordingReattach({ envelope: started.envelope });
  expect(reattached.status).toBe('active');
  if (reattached.status === 'active')
    await expect(reattached.handle.finish()).resolves.toMatchObject({
      status: 'completed',
      result: { warning: expect.stringContaining('likely after reaching the 180s platform limit') },
    });
});

test('keeps a recording finishable when a reattach cannot ask the device about its artifact', async () => {
  let manifest = '';
  let askedAfterStart = false;
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    isRunning: async () => false,
    // A device that will not answer the probe — adb dropped it, the shell never ran — has not said
    // its artifact is gone, so reattach may not declare the recording lost (ADR 0024 2.3).
    exists: async () => (askedAfterStart ? ('uncertain' as const) : true),
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  askedAfterStart = true;

  const reattached = await runtime.screenRecordingReattach({ envelope: started.envelope });
  expect(reattached.status).toBe('active');
  if (reattached.status !== 'active') return;
  await expect(reattached.handle.finish()).resolves.toMatchObject({
    status: 'completed',
    result: { nativePathDisposition: 'retirable' },
  });
});

test('discloses truncation when recovery proved the recorder gone before record stop', async () => {
  let manifest = '';
  const observations = ['ownership-lost', 'missing'] as const;
  let observation = 0;
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    inspect: async () => observations[Math.min(observation++, observations.length - 1)],
    stop: async () => 'uncertain' as const,
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  const reattached = await runtime.screenRecordingReattach({ envelope: started.envelope });
  expect(reattached.status).toBe('active');
  if (reattached.status === 'active')
    await expect(reattached.handle.finish()).resolves.toMatchObject({
      status: 'completed',
      result: { warning: expect.stringContaining('likely after reaching the 180s platform limit') },
    });
});

test('returns fenced native completion after a crash between native finalization and daemon terminalization', async () => {
  let manifest = '';
  const removals: string[] = [];
  let gcWouldFail = false;
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    remove: async (remotePath: string) => {
      removals.push(remotePath);
      return !gcWouldFail;
    },
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  const result = await started.pendingHandle.transfer().finish();
  expect(result.status).toBe('completed');
  expect(JSON.parse(manifest)).toMatchObject({
    completion: { outPath: '/tmp/capture.mp4', nativePathDisposition: 'retirable' },
  });
  gcWouldFail = true;
  if (result.status === 'completed') {
    expect(result.result.nativePathDisposition).toBe('retired');
    await expect(runtime.screenRecordingReattach({ envelope: started.envelope })).resolves.toEqual({
      status: 'completed',
      // The marker froze its disposition before disposal, and the replay answers that one field from
      // the device in front of it, so a completed recording is not still owed a retirement it never
      // had to repeat. One value, from the stop and from the replay alike (ADR 0024 2.3).
      result: result.result,
    });
  }
  expect(removals).toHaveLength(1);
});

test('a device that kept the artifact it was told to remove is still owed the retirement', async () => {
  let manifest = '';
  const removals: string[] = [];
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    remove: async (remotePath: string) => {
      removals.push(remotePath);
      return true;
    },
    // A device that answers `rm` with success and keeps the file: the removal is reported, the
    // artifact is not gone, and the disposition has to say so rather than trust the exit status.
    exists: async () => true,
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  const result = await started.pendingHandle.transfer().finish();

  expect(result.status).toBe('completed');
  if (result.status !== 'completed') return;
  expect(result.result.nativePathDisposition).toBe('retirable');
  await expect(runtime.screenRecordingReattach({ envelope: started.envelope })).resolves.toEqual({
    status: 'completed',
    result: result.result,
  });
  expect(removals).toHaveLength(1);
});

test('a probe that cannot answer after a crash leaves the retirement owed', async () => {
  let manifest = '';
  const removals: string[] = [];
  let removalAttempted = false;
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    remove: async (remotePath: string) => {
      removals.push(remotePath);
      removalAttempted = true;
      return true;
    },
    // A daemon that died before disposal can come back to a device it cannot question: an adb probe
    // that never ran proves nothing about the chunks, so neither the stop nor the replay may claim
    // the device retired them (ADR 0024 2.3).
    exists: async () => (removalAttempted ? ('uncertain' as const) : true),
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  const result = await started.pendingHandle.transfer().finish();

  expect(result.status).toBe('completed');
  if (result.status !== 'completed') return;
  expect(result.result.nativePathDisposition).toBe('retirable');
  await expect(runtime.screenRecordingReattach({ envelope: started.envelope })).resolves.toEqual({
    status: 'completed',
    result: result.result,
  });
  expect(removals).toHaveLength(1);
});

test('retains completed evidence while an exact persisted recorder identity remains alive', async () => {
  let manifest = '';
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    inspect: async () => 'owned-alive' as const,
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  const native = JSON.parse(manifest);
  manifest = JSON.stringify({
    ...native,
    completion: {
      backend: 'adb screenrecord',
      outPath: native.outputPath,
      startedAt: native.startedAt,
      completedAt: native.startedAt + 1,
      scope: native.scope,
      showTouches: native.showTouches,
      recordOnlySession: native.recordOnlySession,
    },
  });

  await expect(
    runtime.screenRecordingReattach({ envelope: started.envelope }),
  ).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'ownership-fence-lost',
  });
  expect(JSON.parse(manifest)).toHaveProperty('completion');
});

test.each([
  ['reassigned to an unrelated process', 'ownership-lost'],
  ['reused by a replacement recorder on the same path', 'foreign-writer'],
] as const)(
  'terminalizes completed evidence whose recorder pid was %s, touching nothing',
  async (_name, ownership) => {
    let manifest = '';
    const removals: string[] = [];
    const runtime = await start({
      writeManifest: async ({ contents }: { contents: string }) => {
        manifest = contents;
      },
      readManifest: async () =>
        manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
      inspect: async () => ownership,
      remove: async (remotePath: string) => {
        removals.push(`artifact:${remotePath}`);
        return true;
      },
      removeManifest: async (manifestPath: string) => {
        removals.push(`marker:${manifestPath}`);
        return true;
      },
    });
    const started = await runtime.screenRecordingStart(recordingInput());
    const native = JSON.parse(manifest);
    manifest = JSON.stringify({
      ...native,
      completion: {
        backend: 'adb screenrecord',
        outPath: native.outputPath,
        startedAt: native.startedAt,
        completedAt: native.startedAt + 1,
        scope: native.scope,
        showTouches: native.showTouches,
        recordOnlySession: native.recordOnlySession,
      },
    });

    await expect(runtime.screenRecordingReattach({ envelope: started.envelope })).resolves.toEqual({
      status: 'completed',
      result: {
        backend: 'adb screenrecord',
        outPath: native.outputPath,
        startedAt: native.startedAt,
        completedAt: native.startedAt + 1,
        scope: native.scope,
        showTouches: native.showTouches,
        recordOnlySession: native.recordOnlySession,
        // Nothing was disposed of here, and the disposition the replay serves is read from the
        // device rather than from the marker — which this marker never carried at all.
        nativePathDisposition: 'retirable',
      },
    });
    expect(removals).toEqual([]);
    expect(JSON.parse(manifest)).toHaveProperty('completion');
  },
);

test('retains pending evidence without signalling an unproven writer', async () => {
  let manifest = '';
  const removed: string[] = [];
  const signals: string[] = [];
  const stopped = new Set<string>();
  const runtime = await start({
    writeManifest: async ({ contents }: { contents: string }) => {
      manifest = contents;
    },
    readManifest: async () =>
      manifest ? { status: 'read' as const, contents: manifest } : { status: 'missing' as const },
    remove: async (remotePath: string) => {
      removed.push(remotePath);
      return true;
    },
    findRunning: async () => ['66'],
    stop: async ({ pid }: { pid: string }) => {
      signals.push(pid);
      stopped.add(pid);
      return 'stopped' as const;
    },
    inspect: async () => 'missing' as const,
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  manifest = JSON.stringify({
    ...JSON.parse(manifest),
    chunks: [],
    pendingRemotePath: recordingArtifactPath(
      '/sdcard',
      {
        deviceId: androidRecordingDevice.id,
        sessionId: recordingInput().sessionId,
        claimToken: recordingInput().claimToken,
        fence: recordingInput().fence,
      },
      777,
    ),
  });
  await expect(
    runtime.screenRecordingReattach({ envelope: started.envelope }),
  ).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'transport-not-reattachable',
    message: 'Android recording launch was interrupted before its process identity was committed.',
  });
  await expect(
    runtime.screenRecordingCleanup({ envelope: started.envelope }),
  ).resolves.toMatchObject({
    status: 'cleanup-pending',
  });
  expect(removed).toEqual([]);
  expect(signals).toEqual([]);
});

test.each([1, 2])(
  'rejects descriptor version %s before it can signal or remove generation material',
  async (version) => {
    let marker = '';
    const effects: string[] = [];
    const runtime = await start({
      readManifest: async () =>
        marker ? { status: 'read' as const, contents: marker } : { status: 'missing' as const },
      writeManifest: async ({ contents }: { contents: string }) => {
        marker = contents;
      },
      stop: async () => {
        effects.push('signal');
        return 'stopped' as const;
      },
      remove: async () => {
        effects.push('remove');
        return true;
      },
    });
    const started = await runtime.screenRecordingStart(recordingInput());
    const before = marker;
    const envelope = {
      ...started.envelope,
      descriptor: { ...started.envelope.descriptor, version },
    };
    await expect(runtime.screenRecordingReattach({ envelope })).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'descriptor-invalid',
    });
    await expect(runtime.screenRecordingCleanup({ envelope })).resolves.toMatchObject({
      status: 'cleanup-pending',
      reason: 'manual-recovery-required',
    });
    expect(marker).toBe(before);
    expect(effects).toEqual([]);
  },
);

test('rejects another generation marker path without signalling the recorder', async () => {
  let marker = '';
  const signals: string[] = [];
  const runtime = await start({
    readManifest: async () =>
      marker ? { status: 'read' as const, contents: marker } : { status: 'missing' as const },
    writeManifest: async ({ contents }: { contents: string }) => {
      marker = contents;
    },
    stop: async ({ pid }: { pid: string }) => {
      signals.push(pid);
      return 'stopped' as const;
    },
  });
  const started = await runtime.screenRecordingStart(recordingInput());
  const body = {
    ...started.envelope.descriptor.body,
    manifestPath: `/sdcard/agent-device-recording-v2-admitted-${'a'.repeat(64)}.json`,
  };
  const envelope = { ...started.envelope, descriptor: { ...started.envelope.descriptor, body } };
  await expect(runtime.screenRecordingReattach({ envelope })).resolves.toMatchObject({
    status: 'unreattachable',
    reason: 'ownership-fence-lost',
  });
  await expect(runtime.screenRecordingCleanup({ envelope })).resolves.toMatchObject({
    status: 'cleanup-pending',
    reason: 'ownership-fence-lost',
  });
  expect(signals).toEqual([]);
});

test.each(['missing-token', 'replaced-token', 'wrong-generation'] as const)(
  'refuses %s native evidence on reattach, cleanup and incomplete-start recovery',
  async (change) => {
    let marker = '';
    const effects: string[] = [];
    let artifactPresent = true;
    const runtime = await start({
      readManifest: async (path: string) =>
        path.includes('recording-v2-') && marker
          ? { status: 'read' as const, contents: marker }
          : { status: 'missing' as const },
      writeManifest: async ({ contents }: { contents: string }) => {
        effects.push('marker-write');
        marker = contents;
      },
      stop: async ({ pid }: { pid: string }) => {
        effects.push(`signal:${pid}`);
        return 'stopped' as const;
      },
      remove: async () => {
        effects.push('remove');
        return true;
      },
      findRunning: async () => [],
      exists: async () => artifactPresent,
    });
    const startInput = recordingInput();
    const started = await runtime.screenRecordingStart(startInput);
    artifactPresent = false;
    effects.length = 0;
    const original = JSON.parse(marker);
    const otherClaim =
      change === 'missing-token'
        ? undefined
        : change === 'replaced-token'
          ? 'successor'
          : startInput.claimToken;
    const otherFence = {
      ...startInput.fence,
      generation: startInput.fence.generation + (change === 'wrong-generation' ? 1 : 0),
    };
    const generation = {
      deviceId: androidRecordingDevice.id,
      sessionId: startInput.sessionId,
      claimToken: otherClaim,
      fence: otherFence,
    };
    const otherPath = recordingArtifactPath('/sdcard', generation, 777);
    marker = JSON.stringify({
      ...original,
      claimToken: otherClaim,
      fenceGeneration: otherFence.generation,
      chunks: [{ ...original.chunks[0], remotePath: otherPath }],
    });
    const envelope = {
      ...started.envelope,
      descriptor: {
        ...started.envelope.descriptor,
        body: {
          ...started.envelope.descriptor.body,
          manifestPath: recordingMarkerPath('/sdcard', generation),
        },
      },
    };
    const before = marker;
    await expect(runtime.screenRecordingReattach({ envelope })).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'ownership-fence-lost',
    });
    await expect(runtime.screenRecordingCleanup({ envelope })).resolves.toMatchObject({
      status: 'cleanup-pending',
      reason: 'ownership-fence-lost',
    });
    expect(marker).toBe(before);
    marker = JSON.stringify({
      ...JSON.parse(before),
      chunks: [],
      pendingRemotePath: otherPath,
      launchDisposition: 'armed',
    });
    const pending = marker;
    await expect(
      runtime.recoverIncompleteRecordingStart({
        sessionId: startInput.sessionId,
        claimToken: startInput.claimToken,
        fence: startInput.fence,
      }),
    ).resolves.toBe('retained');
    expect(marker).toBe(pending);
    expect(effects).toEqual([]);
  },
);

test.each(['missing-token', 'replaced-token', 'wrong-generation'] as const)(
  'settlement retains evidence if the durable envelope loses %s after reattachment',
  async (change) => {
    let marker = '';
    const effects: string[] = [];
    const runtime = await start({
      readManifest: async (path: string) =>
        path.includes('recording-v2-') && marker
          ? { status: 'read' as const, contents: marker }
          : { status: 'missing' as const },
      writeManifest: async ({ contents }: { contents: string }) => {
        effects.push('marker-write');
        marker = contents;
      },
      stop: async ({ pid }: { pid: string }) => {
        effects.push(`signal:${pid}`);
        return 'stopped' as const;
      },
      remove: async () => {
        effects.push('remove');
        return true;
      },
    });
    const started = await runtime.screenRecordingStart(recordingInput());
    const envelope = {
      ...started.envelope,
      metadata: { ...started.envelope.metadata },
      fence: { ...started.envelope.fence },
    };
    const attached = await runtime.screenRecordingReattach({ envelope });
    expect(attached.status).toBe('active');
    if (attached.status !== 'active' || !attached.handle.settleForExport)
      throw new Error('missing settlement authority');
    if (change === 'missing-token') delete envelope.metadata.deviceClaimToken;
    if (change === 'replaced-token') envelope.metadata.deviceClaimToken = 'successor';
    if (change === 'wrong-generation') envelope.fence.generation += 1;
    const before = marker;
    effects.length = 0;
    await expect(
      attached.handle.settleForExport({ learned: {}, record: () => {} }),
    ).resolves.toEqual({ status: 'retained', reason: 'ownership-fence-lost' });
    expect(marker).toBe(before);
    expect(effects).toEqual([]);
  },
);

test.each(['missing-token', 'replaced-token', 'wrong-generation'] as const)(
  'settlement retains changed %s native evidence after an exact reattachment',
  async (change) => {
    let marker = '';
    const effects: string[] = [];
    const runtime = await start({
      readManifest: async (path: string) =>
        path.includes('recording-v2-') && marker
          ? { status: 'read' as const, contents: marker }
          : { status: 'missing' as const },
      writeManifest: async ({ contents }: { contents: string }) => {
        effects.push('marker-write');
        marker = contents;
      },
      stop: async ({ pid }: { pid: string }) => {
        effects.push(`signal:${pid}`);
        return 'stopped' as const;
      },
      remove: async () => {
        effects.push('remove');
        return true;
      },
    });
    const started = await runtime.screenRecordingStart(recordingInput());
    const attached = await runtime.screenRecordingReattach({ envelope: started.envelope });
    expect(attached.status).toBe('active');
    if (attached.status !== 'active' || !attached.handle.settleForExport)
      throw new Error('missing settlement authority');
    const evidence = JSON.parse(marker);
    if (change === 'missing-token') delete evidence.claimToken;
    if (change === 'replaced-token') evidence.claimToken = 'successor';
    if (change === 'wrong-generation') evidence.fenceGeneration += 1;
    marker = JSON.stringify(evidence);
    const before = marker;
    effects.length = 0;
    await expect(
      attached.handle.settleForExport({ learned: {}, record: () => {} }),
    ).resolves.toEqual({ status: 'retained', reason: 'ownership-fence-lost' });
    expect(marker).toBe(before);
    expect(effects).toEqual([]);
  },
);

test.each([undefined, ''])(
  'rejects an absent claim token before native work',
  async (claimToken) => {
    const effects: string[] = [];
    const runtime = await start({
      readManifest: async () => {
        effects.push('read');
        return { status: 'missing' as const };
      },
      writeManifest: async () => {
        effects.push('write');
      },
      start: async () => {
        effects.push('start');
        throw new Error('unexpected');
      },
      outputs: {
        prepare: async () => {
          effects.push('prepare');
        },
      },
    });
    const error = await runtime
      .screenRecordingStart({ ...recordingInput(), claimToken })
      .catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: 'INVALID_ARGS',
      details: { reason: 'recording-claim-token-required' },
    });
    expect(isScreenRecordingStartNotDispatched(error)).toBe(true);
    expect(effects).toEqual([]);
    await expect(
      runtime.recoverIncompleteRecordingStart({
        sessionId: recordingInput().sessionId,
        claimToken: claimToken as string,
        fence: recordingInput().fence,
      }),
    ).resolves.toBe('retained');
    expect(effects).toEqual([]);
  },
);
