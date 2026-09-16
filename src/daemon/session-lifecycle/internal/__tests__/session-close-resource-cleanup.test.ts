import { beforeEach, expect, test, vi } from 'vitest';
import type { AudioProbeLiveHandle } from '@agent-device/contracts/audio-probe-runtime';
import type { AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import {
  createDurableResourceEnvelope,
  encodeDurableDescriptor,
  hostAudioProbeDescriptorCodec,
} from '@agent-device/capture-kit';
import { appLogResourceStore } from '../../../app-log-resource-store.ts';
import { audioProbeResourceStore } from '../../../audio-probe-resource-store.ts';
import {
  sessionCloseShutdownFixture,
  type SessionState,
} from './session-close-shutdown.fixtures.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

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
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
  const statusPath = path.join(
    mkdtempForTestSync('missing-audio-probe'),
    'missing-audio-probe.json',
  );
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
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  expect(finish).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('close force-cleans the app-log stream of an implicit cwd-scoped session at its store address', async () => {
  const sessionStore = makeSessionStore();
  // An implicit cwd-scoped session is named `default` but stored under `cwd:<hash>:default`, and
  // `--session` marks a session explicit, so `--session default` never reaches it (#2031/#1394).
  // Close must therefore tear resources down at the store address, not the bare name: addressing by
  // `session.name` reads a different directory, the app-log fence reports its record missing, and
  // the live `log stream` child is left running while close reports the resource unreleased (#2647).
  const sessionName = 'cwd:8bea844ab16aa9b3:default';
  const device: SessionState['device'] = {
    platform: 'apple',
    id: 'sim-udid-app-log',
    name: 'iPhone 15',
    kind: 'simulator',
    booted: true,
  };
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' as const }));
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId: sessionName,
    device: { id: device.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
    owner: localRuntimeOwner('apple'),
    fence: { token: sessionName + '-fence', generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: { pidPath: '/tmp/app-log.pid' } },
    metadata: { phase: 'active' },
  });
  const appLogHandle: AppLogLiveHandle = {
    inspect: () => ({ backend: 'ios-simulator', state: 'active', startedAt: Date.now() }),
    finish: async () => ({
      status: 'completed' as const,
      result: { backend: 'ios-simulator', outputPath: '/tmp/app.log', completedAt: Date.now() },
    }),
    forceCleanup,
    [Symbol.asyncDispose]: async () => {},
  };
  const session: SessionState = {
    ...makeSession('default', device),
    appBundleId: 'com.apple.Preferences',
    appLog: { handle: appLogHandle, envelope },
  };
  // Register the session under its cwd-scoped address while its `name` stays `default`, and write
  // the durable record where `logs start` left it — under the address directory.
  sessionStore.set(sessionName, session);
  appLogResourceStore.write(
    appLogResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName)),
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
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });

  expect(response?.ok).toBe(true);
  // The live handle was force-cleaned (the `log stream` child killed), its record reached a
  // confirmed terminal state at the address directory, and the session was deleted.
  expect(forceCleanup).toHaveBeenCalledOnce();
  expect(sessionStore.get(sessionName)).toBeUndefined();
  expect(
    appLogResourceStore.read(
      appLogResourceStore.resolvePath(sessionStore.resolveSessionDir(sessionName)),
    ),
  ).toMatchObject({
    status: 'decoded',
    envelope: {
      lifecycle: 'completed',
      metadata: { phase: 'completed', cleanupStatus: 'cleaned' },
    },
  });
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
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
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
