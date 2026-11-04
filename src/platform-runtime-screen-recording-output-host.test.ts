import fs from 'node:fs';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import {
  ANDROID_EMULATOR,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { createAndroidRuntimeModule } from '@agent-device/platform-android';
import type { AndroidScreenRecordingTransport } from '@agent-device/contracts/screen-recording-runtime-host';
import {
  createPlatformRuntimeHost,
  createSnapshotRuntimeHost,
} from './platform-runtime-operation-host.ts';
import { createComposedPlatformRuntimeGateway } from './platform-runtime-gateway.ts';
import { createScreenRecordingOutputHost } from './platform-runtime-screen-recording-output-host.ts';

test('prepares the closed recording output path after semantic validation', async () => {
  const root = mkdtempForTestSync('agent-device-recording-output-');
  const outputPath = path.join(root, 'nested', 'capture.mp4');
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, 'stale');

  await createScreenRecordingOutputHost().prepare(outputPath);

  expect(fs.existsSync(path.dirname(outputPath))).toBe(true);
  expect(fs.existsSync(outputPath)).toBe(false);
});

test('copies a recording file and leaves the source alone', async () => {
  const root = mkdtempForTestSync('agent-device-recording-copy-');
  const from = path.join(root, 'capture.native.mp4');
  const to = path.join(root, 'nested', 'capture.collected.mp4');
  fs.writeFileSync(from, 'recorded');

  await createScreenRecordingOutputHost().copy({ from, to });

  expect(fs.readFileSync(to, 'utf8')).toBe('recorded');
  expect(fs.existsSync(from)).toBe(true);
});

test('copies over whatever already sits at the destination', async () => {
  const root = mkdtempForTestSync('agent-device-recording-copy-');
  const from = path.join(root, 'capture.collected.mp4');
  const to = path.join(root, 'capture.mp4');
  fs.writeFileSync(from, 'recorded');
  fs.writeFileSync(to, 'stale');

  await createScreenRecordingOutputHost().copy({ from, to });

  expect(fs.readFileSync(to, 'utf8')).toBe('recorded');
});

test('copying a recording that is not there fails rather than passing quietly', async () => {
  const root = mkdtempForTestSync('agent-device-recording-copy-');
  await expect(
    createScreenRecordingOutputHost().copy({
      from: path.join(root, 'capture.native.mp4'),
      to: path.join(root, 'capture.collected.mp4'),
    }),
  ).rejects.toThrow(/ENOENT/);
});

test('removes a recording file and says so, including one that was already gone', async () => {
  const root = mkdtempForTestSync('agent-device-recording-remove-');
  const filePath = path.join(root, 'capture.native.mp4');
  fs.writeFileSync(filePath, 'recorded');

  expect(await createScreenRecordingOutputHost().remove(filePath)).toBe('removed');
  expect(fs.existsSync(filePath)).toBe(false);
  expect(await createScreenRecordingOutputHost().remove(filePath)).toBe('removed');
});

test('says a recording file it could not remove is still there instead of throwing', async () => {
  const root = mkdtempForTestSync('agent-device-recording-remove-');
  // A path the host cannot unlink is the case the answer exists for: the caller is told the file may
  // still be there instead of being promised it is gone.
  const filePath = path.join(root, 'capture.native.mp4');
  fs.mkdirSync(filePath);

  expect(await createScreenRecordingOutputHost().remove(filePath)).toBe('present');
  expect(fs.existsSync(filePath)).toBe(true);
});

test('inspects recording presence without changing the file', async () => {
  const root = mkdtempForTestSync('agent-device-recording-inspect-');
  const filePath = path.join(root, 'capture.native.mp4');
  const output = createScreenRecordingOutputHost();
  await expect(output.inspect(filePath)).resolves.toBe('missing');
  fs.writeFileSync(filePath, 'recorded');
  await expect(output.inspect(filePath)).resolves.toBe('present');
  expect(fs.readFileSync(filePath, 'utf8')).toBe('recorded');
  fs.unlinkSync(filePath);
  fs.mkdirSync(filePath);
  await expect(output.inspect(filePath)).resolves.toBe('missing');
  const loopPath = path.join(root, 'loop');
  fs.symlinkSync('loop', loopPath);
  await expect(output.inspect(loopPath)).resolves.toBe('unavailable');
});

test('Android repeat finish and reattach reject a directory in place of a second video chunk', async () => {
  const root = mkdtempForTestSync('android-output-inspector-');
  const stateDir = path.join(root, 'state');
  const host = createTestHostEnvironment({
    cwd: root,
    env: { ...process.env, AGENT_DEVICE_CLAIMS_DIR: path.join(root, 'claims') },
  });
  const markers = new Map<string, string>();
  const files = new Set<string>();
  const running = new Set<string>();
  let admission: string | undefined;
  let allowRelease = false;
  const launched: string[] = [];
  const release = vi.fn<AndroidScreenRecordingTransport['releaseAdmission']>(
    async ({ owner, manifestPath, expected }) => {
      if (!allowRelease) return 'unavailable';
      if ((markers.get(manifestPath) ?? null) !== expected || admission !== owner)
        return 'not-owner';
      admission = undefined;
      return 'released';
    },
  );
  const transport: AndroidScreenRecordingTransport = {
    mode: 'local',
    acquireAdmission: async (owner) => {
      if (admission) return 'busy';
      admission = owner;
      return 'acquired';
    },
    releaseAdmission: release,
    start: async ({ remotePath, admission: request }) => {
      if (admission !== request.owner || markers.get(request.manifestPath) !== request.expected)
        throw new Error('native admission did not match');
      markers.set(request.manifestPath, request.admitted);
      running.add(remotePath);
      files.add(remotePath);
      launched.push(remotePath);
      return { process: { pid: String(40 + launched.length), startTime: '100', remotePath } };
    },
    inspect: async ({ remotePath }) => (running.has(remotePath) ? 'owned-alive' : 'missing'),
    stop: async ({ remotePath }) => (running.delete(remotePath) ? 'stopped' : 'already-missing'),
    exists: async (remotePath) => files.has(remotePath),
    size: async (remotePath) => (files.has(remotePath) ? 12 : undefined),
    probeRunningWriters: async (remotePath) => ({
      conclusive: true,
      writers: running.has(remotePath) ? [{ pid: '42', startTime: '100', remotePath }] : [],
    }),
    pullPlayable: async ({ outputPath }) => {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, 'native video');
      return { stdout: '', stderr: '', exitCode: 0, playable: true };
    },
    remove: async (remotePath) => {
      files.delete(remotePath);
      return true;
    },
    manifestPathFor: (remotePath) => {
      const match = /^agent-device-recording-v2-admitted-([a-f0-9]{64})-\d{1,20}\.mp4$/.exec(
        path.posix.basename(remotePath),
      );
      if (!match || path.posix.dirname(remotePath) !== '/sdcard')
        throw new Error('unexpected generation path');
      return `/sdcard/agent-device-recording-v2-admitted-${match[1]}.json`;
    },
    readManifest: async (manifestPath) => {
      const contents = markers.get(manifestPath);
      return contents === undefined ? { status: 'missing' } : { status: 'read', contents };
    },
    compareAndSetManifest: async ({ manifestPath, expected, contents }) => {
      if ((markers.get(manifestPath) ?? null) !== expected) return 'mismatch';
      if (contents === null) markers.delete(manifestPath);
      else markers.set(manifestPath, contents);
      return 'updated';
    },
  };
  const unsupported = async (): Promise<never> => {
    throw new Error('unused fixture port');
  };
  const baseHost = createPlatformRuntimeHost({
    host,
    sessionsDir: path.join(stateDir, 'sessions'),
    resolveSessionArtifacts: () => ({
      outputPath: path.join(root, 'unused.log'),
      pidPath: path.join(root, 'unused.pid'),
    }),
    shutdownLoaders: { apple: unsupported, android: unsupported },
    snapshot: createSnapshotRuntimeHost({ linux: unsupported, macos: unsupported }),
  });
  const operationHost = {
    ...baseHost,
    androidTools: {
      ...baseHost.androidTools,
      probeClipboardShellSupport: async () => 'unsupported' as const,
    },
    screenRecording: {
      ...baseHost.screenRecording,
      android: { resolve: async () => transport },
      finalize: { prepare: async () => {}, sniff: async () => {}, complete: async () => ({}) },
    },
  };
  const gateway = createComposedPlatformRuntimeGateway({
    modules: new Map([['android', createAndroidRuntimeModule({ bindAdbHost: async () => {} })]]),
    loadHost: async () => operationHost,
  });
  const scope = {
    signal: new AbortController().signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
  const output = path.join(root, 'capture.mp4');
  const secondChunk = path.join(root, 'capture.part-002.mp4');
  const fence = { token: 'test-fence', generation: 1 };
  vi.useFakeTimers();
  try {
    const binding = await gateway.bind({
      device: ANDROID_EMULATOR,
      intent: { kind: 'ordinary' },
      scope,
    });
    const start = binding.operations.screenRecordingStart;
    if (!start) throw new Error('Android recording start is unavailable');
    const started = await start({
      sessionId: 'recording',
      claimToken: 'test-claim',
      outputPath: output,
      fence,
      scope: 'device',
      showTouches: false,
      hideTouchesRequested: false,
      recordOnlySession: true,
    });
    const handle = started.pendingHandle.transfer();
    await vi.advanceTimersByTimeAsync(170_000);
    expect(launched).toHaveLength(2);
    const first = handle.finish();
    await Promise.all([
      vi.advanceTimersByTimeAsync(2_000),
      expect(first).resolves.toMatchObject({
        status: 'completed',
        result: { outPath: output, chunks: [{ path: output }, { path: secondChunk }] },
        cleanupPending: { reason: 'cleanup-unconfirmed' },
      }),
    ]);
    fs.unlinkSync(secondChunk);
    fs.mkdirSync(secondChunk);
    const previousAttempts = release.mock.calls.length;
    await expect(handle.finish()).rejects.toMatchObject({
      details: { reason: 'resource-missing', outPath: secondChunk },
    });
    expect(release.mock.calls.length).toBeGreaterThan(previousAttempts);
    expect(admission).toBeDefined();
    allowRelease = true;
    const exact = await gateway.bind({
      device: ANDROID_EMULATOR,
      intent: { kind: 'exact-owner', owner: binding.owner, fence },
      scope,
    });
    const beforeReattach = release.mock.calls.length;
    const reattach = exact.operations.screenRecordingReattach;
    if (!reattach) throw new Error('Android recording reattach is unavailable');
    await expect(reattach({ envelope: started.envelope })).resolves.toMatchObject({
      status: 'unreattachable',
      reason: 'resource-missing',
    });
    expect(release.mock.calls.length).toBeGreaterThan(beforeReattach);
    expect(admission).toBeUndefined();
    expect(JSON.parse([...markers.values()][0]!)).toMatchObject({ admissionReleased: true });
    expect(fs.readFileSync(output, 'utf8')).toBe('native video');
    expect(fs.statSync(secondChunk).isDirectory()).toBe(true);
    expect(await transport.acquireAdmission('b'.repeat(64))).toBe('acquired');
    await expect(handle.finish()).rejects.toMatchObject({
      details: { reason: 'resource-missing', outPath: secondChunk },
    });
    expect(admission).toBe('b'.repeat(64));
    await exact[Symbol.asyncDispose]();
    await binding[Symbol.asyncDispose]();
  } finally {
    vi.useRealTimers();
    await gateway.shutdown();
  }
});
