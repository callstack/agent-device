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
