import { beforeEach, expect, test, vi } from 'vitest';
import type { AudioProbeLiveHandle } from '@agent-device/contracts/audio-probe-runtime';
import {
  createDurableResourceEnvelope,
  encodeDurableDescriptor,
  hostAudioProbeDescriptorCodec,
} from '@agent-device/capture-kit';
import { audioProbeResourceStore } from '../../audio-probe-resource-store.ts';
import {
  sessionCloseShutdownFixture,
  type SessionState,
} from './session-close-shutdown.fixtures.ts';

const {
  AppError,
  handleSessionCommands,
  LeaseRegistry,
  localRuntimeOwner,
  makeSession,
  makeSessionStore,
  mockCleanupAndroidNativePerfSession,
  mockCleanupAppleXctracePerfCapture,
  mockDispatchCommand,
  mockStopAndroidSnapshotHelperSessionForDevice,
  noopInvoke,
  os,
  path,
  resetSessionCloseShutdownMocks,
  WEB_DESKTOP_DEVICE,
} = sessionCloseShutdownFixture;

beforeEach(resetSessionCloseShutdownMocks);

test('close stops Android snapshot helper session before deleting session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-snapshot-helper-session';
  const device: SessionState['device'] = {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Pixel_9_API_35',
    kind: 'emulator',
    booted: true,
  };
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, device),
    appBundleId: 'com.example.app',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockStopAndroidSnapshotHelperSessionForDevice).toHaveBeenCalledWith(device);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close stops active Apple xctrace perf capture before deleting session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-active-xctrace-session';
  const activeCapture = {
    kind: 'xctrace',
    mode: 'cpu-profile',
    template: 'Time Profiler',
    outPath: '/tmp/app.trace',
    appBundleId: 'com.example.app',
    deviceId: 'sim-udid-4',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: { kill: vi.fn(() => true), pid: 1234 },
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-udid-4',
      name: 'iPhone 15',
      kind: 'simulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    applePerf: {
      active: activeCapture,
    },
  } as unknown as SessionState);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockCleanupAppleXctracePerfCapture).toHaveBeenCalledWith(activeCapture);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close stops active Android native perf capture before deleting session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-active-native-perf-session';
  const activeCapture = {
    type: 'trace',
    kind: 'perfetto',
    packageName: 'com.example.app',
    appPid: '1234',
    profilerPid: '5678',
    remotePath: '/data/misc/perfetto-traces/app.perfetto-trace',
    outPath: '/tmp/app.perfetto-trace',
    startedAt: Date.now(),
    state: 'running',
  };
  const session = {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    nativePerf: {
      android: activeCapture,
    },
  } as unknown as SessionState;
  sessionStore.set(sessionName, session);

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockCleanupAndroidNativePerfSession).toHaveBeenCalledWith(session.device, activeCapture);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close stops active host audio probe before deleting session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-active-audio-probe-session';
  const statusPath = path.join(os.tmpdir(), 'missing-audio-probe.json');
  const startedAt = Date.now() - 2000;
  const stoppedResult = {
    audio: 'probe' as const,
    state: 'stopped' as const,
    active: false,
    heard: false,
    source: 'system-audio' as const,
    backend: 'macos-screencapturekit',
    durationMs: 10000,
    elapsedMs: 2000,
    bucketMs: 1000,
    sampleCount: 2,
    sourceCount: 1,
    rmsDbfs: [] as number[],
    peakDbfs: [] as number[],
  };
  const finish = vi.fn(async () => ({ status: 'completed' as const, result: stoppedResult }));
  const handle: AudioProbeLiveHandle = {
    inspect: () => ({
      source: 'system-audio' as const,
      backend: 'macos-screencapturekit',
      sourceCount: 1,
      notes: [],
      statusPath,
      startedAt,
      durationMs: 10000,
      bucketMs: 1000,
    }),
    status: async () => stoppedResult,
    finish,
    forceCleanup: async () => ({ status: 'cleaned' }) as const,
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'audio-probe',
    sessionId: sessionName,
    device: { id: 'macos', family: 'apple', appleOs: 'macos', kind: 'device' },
    owner: localRuntimeOwner('apple'),
    fence: { token: sessionName + '-fence', generation: 1 },
    lifecycle: 'open',
    descriptor: encodeDurableDescriptor(hostAudioProbeDescriptorCodec, {
      backend: 'macos-screencapturekit',
      source: 'system-audio',
      sourceCount: 1,
      notes: [],
      statusPath,
      startedAt,
      durationMs: 10000,
      bucketMs: 1000,
      marker: { pid: 4242, startTime: 'boot+1', command: 'helper' },
    }),
  });
  const session: SessionState = {
    ...makeSession(sessionName, {
      platform: 'apple',
      appleOs: 'macos',
      id: 'macos',
      name: 'Mac',
      kind: 'device',
      booted: true,
    }),
    audioProbe: { handle, envelope },
  };
  sessionStore.set(sessionName, session);
  audioProbeResourceStore.write(
    audioProbeResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName)),
    envelope,
  );

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close dispatches web session cleanup without a positional target', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'web-close-session';
  sessionStore.set(sessionName, makeSession(sessionName, WEB_DESKTOP_DEVICE));

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatchCommand).toHaveBeenCalledWith(
    WEB_DESKTOP_DEVICE,
    'close',
    [],
    undefined,
    expect.objectContaining({ logPath: expect.stringContaining('daemon.log') }),
  );
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close preserves the session and lease when provider release fails so it can be retried', async () => {
  const sessionStore = makeSessionStore();
  const leaseRegistry = new LeaseRegistry();
  const sessionName = 'provider-release-failure-session';
  const lease = leaseRegistry.allocateLease({
    tenantId: 'tenant-a',
    runId: 'run-1',
    leaseProvider: 'browserstack',
    deviceKey: 'ios:bs-device',
    clientId: 'client-a',
  });
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, WEB_DESKTOP_DEVICE),
    lease: {
      leaseId: lease.leaseId,
      tenantId: lease.tenantId,
      runId: lease.runId,
      leaseBackend: lease.backend,
      leaseProvider: lease.leaseProvider,
      deviceKey: lease.deviceKey,
      clientId: lease.clientId,
      expiresAt: lease.expiresAt,
    },
  });

  let releaseAttempts = 0;
  const request = {
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    leaseRegistry,
    leaseLifecycleProvider: {
      release: async () => {
        releaseAttempts += 1;
        if (releaseAttempts === 1) {
          throw new AppError('COMMAND_FAILED', 'provider cleanup failed');
        }
        return { releasedBy: 'provider' };
      },
    },
    invoke: noopInvoke,
  };

  const failed = await handleSessionCommands(request);
  expect(failed).toMatchObject({
    ok: false,
    error: {
      code: 'COMMAND_FAILED',
      retriable: true,
      details: { session: sessionName },
    },
  });
  expect(sessionStore.get(sessionName)?.lease?.leaseId).toBe(lease.leaseId);
  expect(leaseRegistry.listActiveLeases()).toHaveLength(1);

  const retried = await handleSessionCommands(request);
  expect(retried).toMatchObject({
    ok: true,
    data: { provider: { releasedBy: 'provider' } },
  });
  expect(releaseAttempts).toBe(2);
  expect(sessionStore.get(sessionName)).toBeUndefined();
  expect(leaseRegistry.listActiveLeases()).toHaveLength(0);
});

test('close still runs later cleanup and deletes the session after an earlier cleanup rejects', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-close-isolation-session';
  const activeCapture = {
    type: 'trace',
    kind: 'perfetto',
    packageName: 'com.example.app',
    appPid: '1234',
    profilerPid: '5678',
    remotePath: '/data/misc/perfetto-traces/app.perfetto-trace',
    outPath: '/tmp/app.perfetto-trace',
    startedAt: Date.now(),
    state: 'running',
  };
  const session = {
    ...makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Pixel',
      kind: 'emulator',
      booted: true,
    }),
    appBundleId: 'com.example.app',
    nativePerf: {
      android: activeCapture,
    },
  } as unknown as SessionState;
  sessionStore.set(sessionName, session);

  mockCleanupAndroidNativePerfSession.mockRejectedValueOnce(
    new AppError('COMMAND_FAILED', 'perfetto stop failed'),
  );

  await expect(
    handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'close',
        positionals: [],
        flags: {},
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    }),
  ).rejects.toMatchObject({
    details: expect.objectContaining({
      reason: 'session_cleanup_incomplete',
      failedSteps: ['android_native_perf'],
    }),
  });

  // A later cleanup step still ran, and the session was still deleted.
  expect(mockStopAndroidSnapshotHelperSessionForDevice).toHaveBeenCalledWith(session.device);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});
