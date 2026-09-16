import { beforeEach, expect, test, vi } from 'vitest';
import type { AppLogLiveHandle } from '@agent-device/contracts/app-log-runtime';
import type { AudioProbeLiveHandle } from '@agent-device/contracts/audio-probe-runtime';
import type { PerfNativeCaptureLiveHandle } from '@agent-device/contracts/perf-runtime';
import type { DurableResourceEnvelope } from '@agent-device/contracts/durable-resource-envelope';
import {
  createDurableResourceEnvelope,
  encodeDurableDescriptor,
  hostAudioProbeDescriptorCodec,
} from '@agent-device/capture-kit';
import { appLogResourceStore } from '../../../app-log-resource-store.ts';
import { audioProbeResourceStore } from '../../../audio-probe-resource-store.ts';
import { perfCaptureResourceStore } from '../../../perf-capture-resource-store.ts';
import { screenRecordingResourceStore } from '../../../screen-recording-resource-store.ts';
import type { DurableCaptureResourceStore } from '@agent-device/capture-kit/durable-capture';
import {
  sessionCloseShutdownFixture,
  type SessionState,
} from './session-close-shutdown.fixtures.ts';
import { mkdtempForTestSync } from '../../../../__tests__/test-utils/tmp-dir.ts';

const {
  handleSessionCommands,
  localRuntimeOwner,
  makeIosSimulatorRecordingSession,
  makeSession,
  makeSessionStore,
  noopInvoke,
  path,
  recordingFinishMock,
  resetSessionCloseShutdownMocks,
} = sessionCloseShutdownFixture;

beforeEach(resetSessionCloseShutdownMocks);

// An implicitly cwd-scoped session is *named* `default` but *stored* under `cwd:<hash>:default`
// (`SessionRef`). Each durable-capture record lives in the address's directory, so close teardown
// must address every resource by the store address. If a step goes back to `session.name`:
// - app_log, audio_probe, perf_capture fail with "<Kind> resource record is missing", because
//   the record is read from the bare-name directory, which holds none.
// - recording fails on `finish` not being called for the addressed session, because
//   `finishSessionScreenRecording` re-reads the store by name and finishes the decoy stored
//   under `default` instead.
const ADDRESS = 'cwd:0f803c4542a46e92:default';
const NAME = 'default';
const IOS_SIM: SessionState['device'] = {
  platform: 'apple',
  appleOs: 'ios',
  id: '9105AAA0-3184-40BC-A9FC-46634C90DFFB',
  name: 'iPhone 16',
  kind: 'simulator',
  booted: true,
};

async function closeAtAddress(sessionStore: ReturnType<typeof makeSessionStore>) {
  return await handleSessionCommands({
    req: { token: 't', session: ADDRESS, command: 'close', positionals: [], flags: {} },
    sessionName: ADDRESS,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
}

function expectCompleted<K extends string>(
  store: DurableCaptureResourceStore<K>,
  resourcePath: string,
): void {
  const record = store.read(resourcePath);
  expect(record.status).toBe('decoded');
  if (record.status === 'decoded') expect(record.envelope.lifecycle).toBe('completed');
}

test('close finishes the recording of a cwd-scoped session by store address', async () => {
  const sessionStore = makeSessionStore();
  const session = makeIosSimulatorRecordingSession(sessionStore, ADDRESS, { name: NAME });
  const finish = recordingFinishMock(session);
  sessionStore.set(ADDRESS, session);
  const resourcePath = screenRecordingResourceStore.resolvePath(
    sessionStore.resolveSessionDir(ADDRESS),
  );
  // `--session default` addresses a *different* session stored under the bare name. Give it
  // its own live recording so a `currentSession` lookup by `session.name` would finish the
  // wrong one instead of falling back to `session` and staying green.
  const decoy = makeIosSimulatorRecordingSession(sessionStore, NAME, {
    device: { ...IOS_SIM, id: 'decoy-udid', name: 'iPhone 15' },
  });
  const decoyFinish = recordingFinishMock(decoy);
  sessionStore.set(NAME, decoy);
  const decoyResourcePath = screenRecordingResourceStore.resolvePath(
    sessionStore.resolveSessionDir(NAME),
  );

  const response = await closeAtAddress(sessionStore);

  expect(response?.ok).toBe(true);
  expect(finish).toHaveBeenCalledOnce();
  expectCompleted(screenRecordingResourceStore, resourcePath);
  expect(sessionStore.get(ADDRESS)).toBeUndefined();
  // The decoy is untouched: not finished, record still open, session still stored.
  expect(decoyFinish).not.toHaveBeenCalled();
  const decoyRecord = screenRecordingResourceStore.read(decoyResourcePath);
  expect(decoyRecord.status).toBe('decoded');
  if (decoyRecord.status === 'decoded') expect(decoyRecord.envelope.lifecycle).toBe('open');
  expect(sessionStore.get(NAME)).toBeDefined();
});

test('close stops the app log of a cwd-scoped session by store address', async () => {
  const sessionStore = makeSessionStore();
  const sessionDir = sessionStore.resolveSessionDir(ADDRESS);
  const outputPath = path.join(sessionDir, 'app.log');
  const forceCleanup = vi.fn(async () => ({ status: 'cleaned' }) as const);
  const handle: AppLogLiveHandle = {
    inspect: () => ({ backend: 'ios-simulator', state: 'active', startedAt: Date.now() - 1000 }),
    finish: async () => ({
      status: 'completed' as const,
      result: { backend: 'ios-simulator', outputPath, completedAt: Date.now() },
    }),
    forceCleanup,
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope: DurableResourceEnvelope<'app-log'> = createDurableResourceEnvelope({
    resourceKind: 'app-log',
    sessionId: ADDRESS,
    device: {
      id: IOS_SIM.id,
      family: 'apple',
      appleOs: 'ios',
      kind: 'simulator',
      target: 'mobile',
    },
    owner: localRuntimeOwner('apple'),
    fence: { token: 'app-log-fence', generation: 1 },
    lifecycle: 'open',
    descriptor: {
      version: 1,
      body: {
        transport: 'apple-log-stream',
        backend: 'ios-simulator',
        outputPath,
        pidPath: path.join(sessionDir, 'app-log.pid'),
      },
    },
    metadata: { phase: 'active' },
  });
  sessionStore.set(ADDRESS, {
    ...makeSession(NAME, IOS_SIM),
    appBundleId: 'com.apple.Preferences',
    appLog: { handle, envelope },
  });
  const resourcePath = appLogResourceStore.resolvePath(sessionDir);
  appLogResourceStore.write(resourcePath, envelope);

  const response = await closeAtAddress(sessionStore);

  expect(response?.ok).toBe(true);
  expect(forceCleanup).toHaveBeenCalledOnce();
  expectCompleted(appLogResourceStore, resourcePath);
  expect(sessionStore.get(ADDRESS)).toBeUndefined();
});

test('close finishes the audio probe of a cwd-scoped session by store address', async () => {
  const sessionStore = makeSessionStore();
  const sessionDir = sessionStore.resolveSessionDir(ADDRESS);
  const statusPath = path.join(sessionDir, 'audio-probe.json');
  const startedAt = Date.now() - 2000;
  const stopped = {
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
  const finish = vi.fn(async () => ({ status: 'completed' as const, result: stopped }));
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
    status: async () => stopped,
    finish,
    forceCleanup: async () => ({ status: 'cleaned' }) as const,
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'audio-probe',
    sessionId: ADDRESS,
    device: { id: IOS_SIM.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
    owner: localRuntimeOwner('apple'),
    fence: { token: 'audio-probe-fence', generation: 1 },
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
  sessionStore.set(ADDRESS, { ...makeSession(NAME, IOS_SIM), audioProbe: { handle, envelope } });
  const resourcePath = audioProbeResourceStore.resolvePath(sessionDir);
  audioProbeResourceStore.write(resourcePath, envelope);

  const response = await closeAtAddress(sessionStore);

  expect(response?.ok).toBe(true);
  expect(finish).toHaveBeenCalledOnce();
  expectCompleted(audioProbeResourceStore, resourcePath);
  expect(sessionStore.get(ADDRESS)).toBeUndefined();
});

test('close stops the perf capture of a cwd-scoped session by store address', async () => {
  const sessionStore = makeSessionStore();
  const sessionDir = sessionStore.resolveSessionDir(ADDRESS);
  const finish = vi.fn(async () => ({
    status: 'completed' as const,
    result: {
      kind: 'xctrace',
      mode: 'trace',
      state: 'stopped',
      outPath: path.join(sessionDir, 'app.trace'),
    } as const,
  }));
  const handle: PerfNativeCaptureLiveHandle = {
    inspect: () => ({ kind: 'xctrace', mode: 'trace', state: 'running' }),
    setOutputPath: vi.fn(),
    finish,
    forceCleanup: async () => ({ status: 'cleaned' }) as const,
    [Symbol.asyncDispose]: async () => {},
  };
  const envelope = createDurableResourceEnvelope({
    resourceKind: 'perf-capture',
    sessionId: ADDRESS,
    device: { id: IOS_SIM.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
    owner: localRuntimeOwner('apple'),
    fence: { token: 'perf-capture-fence', generation: 1 },
    lifecycle: 'open',
    descriptor: { version: 1, body: { kind: 'fixture' } },
  });
  sessionStore.set(ADDRESS, { ...makeSession(NAME, IOS_SIM), perfCapture: { handle, envelope } });
  const resourcePath = perfCaptureResourceStore.resolvePath(sessionDir);
  perfCaptureResourceStore.write(resourcePath, envelope);

  const response = await closeAtAddress(sessionStore);

  expect(response?.ok).toBe(true);
  expect(finish).toHaveBeenCalledOnce();
  expectCompleted(perfCaptureResourceStore, resourcePath);
  expect(sessionStore.get(ADDRESS)).toBeUndefined();
});
