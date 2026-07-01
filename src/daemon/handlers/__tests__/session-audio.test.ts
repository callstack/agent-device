import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import {
  IOS_DEVICE,
  WEB_DESKTOP_DEVICE,
  makeAndroidSession,
  makeIosSession,
  makeMacOsSession,
  makeSession,
} from '../../../__tests__/test-utils/index.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { WebProvider } from '../../../platforms/web/provider.ts';
import { withWebProvider } from '../../../platforms/web/provider.ts';
import type { DaemonResponse } from '../../types.ts';

const macosAudioMocks = vi.hoisted(() => ({
  startMacOsAudioProbeProcess: vi.fn(),
}));

vi.mock('../../../platforms/apple/os/macos/helper.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/os/macos/helper.ts')>();
  return {
    ...actual,
    startMacOsAudioProbeProcess: macosAudioMocks.startMacOsAudioProbeProcess,
  };
});
import { handleSessionObservabilityCommands } from '../session-observability.ts';

beforeEach(() => {
  vi.resetAllMocks();
});

test('audio probe validates daemon duration bounds', async () => {
  const provider = makeAudioWebProvider();
  const response = await runAudioCommand(['probe', 'start', '99', '1000'], provider);

  assertInvalidArgs(response, /duration must be an integer in range 100..120000/);
  assert.equal(provider.probeAudio.mock.calls.length, 0);
});

test('audio probe rejects non-web sessions in daemon handler', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  sessionStore.set('ios-device', makeIosSession('ios-device', { device: IOS_DEVICE }));
  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios-device',
      command: 'audio',
      positionals: ['probe', 'status'],
      flags: {},
    },
    sessionName: 'ios-device',
    sessionStore,
  });

  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'UNSUPPORTED_OPERATION');
    assert.match(response.error.message, /web browser sessions, macOS sessions, iOS simulators/);
  }
});

test('audio probe starts macOS ScreenCaptureKit helper and reads status', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  sessionStore.set('macos', makeMacOsSession('macos'));
  const kill = mockHostAudioProbeStart({
    elapsedMs: 1000,
    rmsDbfs: [-12],
    peakDbfs: [-8],
    notes: ['helper status'],
  });

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'macos',
      command: 'audio',
      positionals: ['probe', 'start', '1000', '500'],
      flags: {},
    },
    sessionName: 'macos',
    sessionStore,
  });

  if (process.platform !== 'darwin') {
    assertHostAudioUnsupportedResponse(response);
    assert.equal(macosAudioMocks.startMacOsAudioProbeProcess.mock.calls.length, 0);
    return;
  }

  assert.ok(response?.ok);
  assert.equal(response.data?.backend, 'macos-screencapturekit');
  assert.equal(response.data?.source, 'system-audio');
  assert.deepEqual(response.data?.rmsDbfs, [-12]);
  assert.deepEqual(response.data?.notes, [
    'helper status',
    'Audio probe samples host system audio through ScreenCaptureKit for this macOS session; it is not app-instrumented audio.',
    'Screen Recording permission is required for host system audio capture.',
    'Other audible host apps can contribute to the measured buckets.',
  ]);
  assert.equal(macosAudioMocks.startMacOsAudioProbeProcess.mock.calls.length, 1);
  assert.equal(macosAudioMocks.startMacOsAudioProbeProcess.mock.calls[0]?.[0].durationMs, 1000);
  assert.equal(macosAudioMocks.startMacOsAudioProbeProcess.mock.calls[0]?.[0].bucketMs, 500);
  assert.equal(kill.mock.calls.length, 0);
});

test('audio probe stop kills active macOS helper and returns stopped status', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  const session = makeMacOsSession('macos');
  const statusPath = path.join(sessionStore.ensureSessionDir('macos'), 'audio-probe.json');
  await writeHostAudioProbeStatus(statusPath, {
    state: 'running',
    active: true,
    heard: true,
    durationMs: 10000,
    elapsedMs: 2000,
    bucketMs: 1000,
    sampleCount: 2,
    rmsDbfs: [-15, -14],
    peakDbfs: [-9, -8],
  });
  const kill = vi.fn();
  session.audioProbe = {
    platform: 'host-system-audio',
    source: 'system-audio',
    backend: 'macos-screencapturekit',
    sourceCount: 1,
    notes: [
      'Audio probe samples host system audio through ScreenCaptureKit for this macOS session; it is not app-instrumented audio.',
      'Screen Recording permission is required for host system audio capture.',
      'Other audible host apps can contribute to the measured buckets.',
    ],
    child: { kill, pid: 1234 },
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    statusPath,
    startedAt: Date.now() - 2000,
    durationMs: 10000,
    bucketMs: 1000,
  };
  sessionStore.set('macos', session);

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'macos',
      command: 'audio',
      positionals: ['probe', 'stop'],
      flags: {},
    },
    sessionName: 'macos',
    sessionStore,
  });

  if (process.platform !== 'darwin') {
    assertHostAudioUnsupportedResponse(response);
    assert.equal(kill.mock.calls.length, 0);
    return;
  }

  assert.ok(response?.ok);
  assert.equal(kill.mock.calls[0]?.[0], 'SIGTERM');
  assert.equal(sessionStore.get('macos')?.audioProbe, undefined);
  assert.equal(response.data?.state, 'stopped');
  assert.equal(response.data?.active, false);
  assert.deepEqual(response.data?.peakDbfs, [-9, -8]);
});

test('audio probe starts host helper for iOS simulator audio', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  sessionStore.set('ios', makeIosSession('ios'));
  mockHostAudioProbeStart({
    elapsedMs: 500,
    rmsDbfs: [-18],
    peakDbfs: [-12],
  });

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'audio',
      positionals: ['probe', 'start', '1000', '500'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });

  if (process.platform !== 'darwin') {
    assertHostAudioUnsupportedResponse(response);
    assert.equal(macosAudioMocks.startMacOsAudioProbeProcess.mock.calls.length, 0);
    return;
  }

  assert.ok(response?.ok);
  assert.equal(sessionStore.get('ios')?.audioProbe?.platform, 'host-system-audio');
  assert.equal(response.data?.source, 'system-audio');
  assert.deepEqual(response.data?.rmsDbfs, [-18]);
  assert.ok(Array.isArray(response.data?.notes));
  assert.match(String(response.data.notes[0]), /iOS simulator/);
});

test('audio probe starts host helper for Android emulator audio', async () => {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  sessionStore.set('android', makeAndroidSession('android'));
  mockHostAudioProbeStart({
    elapsedMs: 500,
    rmsDbfs: [-20],
    peakDbfs: [-13],
  });

  const response = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'android',
      command: 'audio',
      positionals: ['probe', 'start', '1000', '500'],
      flags: {},
    },
    sessionName: 'android',
    sessionStore,
  });

  if (process.platform !== 'darwin') {
    assertHostAudioUnsupportedResponse(response);
    assert.equal(macosAudioMocks.startMacOsAudioProbeProcess.mock.calls.length, 0);
    return;
  }

  assert.ok(response?.ok);
  assert.equal(sessionStore.get('android')?.audioProbe?.platform, 'host-system-audio');
  assert.equal(response.data?.source, 'system-audio');
  assert.deepEqual(response.data?.peakDbfs, [-13]);
  assert.ok(Array.isArray(response.data?.notes));
  assert.match(String(response.data.notes[0]), /Android emulator/);
});

test('audio probe validates daemon bucket bounds', async () => {
  const provider = makeAudioWebProvider();
  const response = await runAudioCommand(['probe', 'start', '1000', '99'], provider);

  assertInvalidArgs(response, /bucket must be an integer in range 100..10000/);
  assert.equal(provider.probeAudio.mock.calls.length, 0);
});

test('audio probe rejects timing positionals for status', async () => {
  const provider = makeAudioWebProvider();
  const response = await runAudioCommand(['probe', 'status', '1000'], provider);

  assertInvalidArgs(response, /only supported with audio probe start/);
  assert.equal(provider.probeAudio.mock.calls.length, 0);
});

test('audio probe forwards daemon millisecond timing to web provider', async () => {
  const provider = makeAudioWebProvider();
  const response = await runAudioCommand(['probe', 'start', '7500', '500'], provider);

  assert.equal(response?.ok, true);
  assert.deepEqual(provider.probeAudio.mock.calls[0]?.[0], {
    action: 'start',
    durationMs: 7500,
    bucketMs: 500,
  });
});

async function runAudioCommand(
  positionals: string[],
  provider: WebProvider = makeAudioWebProvider(),
): Promise<DaemonResponse | null> {
  const sessionStore = makeSessionStore('agent-device-session-audio-');
  sessionStore.set('web', makeSession('web', { device: WEB_DESKTOP_DEVICE }));
  return await withWebProvider(
    provider,
    async () =>
      await handleSessionObservabilityCommands({
        req: {
          token: 't',
          session: 'web',
          command: 'audio',
          positionals,
          flags: {},
        },
        sessionName: 'web',
        sessionStore,
      }),
  );
}

function assertInvalidArgs(response: DaemonResponse | null, message: RegExp): void {
  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'INVALID_ARGS');
    assert.match(response.error.message, message);
  }
}

function assertHostAudioUnsupportedResponse(response: DaemonResponse | null): void {
  assert.equal(response?.ok, false);
  if (response && !response.ok) {
    assert.equal(response.error.code, 'UNSUPPORTED_OPERATION');
    assert.match(
      response.error.message,
      /web browser sessions, macOS sessions, iOS simulators, and Android emulators on macOS hosts/,
    );
  }
}

type HostAudioProbeStartOptions = {
  durationMs: number;
  bucketMs: number;
  statusPath: string;
};

type HostAudioProbeStatus = {
  elapsedMs: number;
  rmsDbfs: number[];
  peakDbfs: number[];
  notes?: string[];
};

function mockHostAudioProbeStart(status: HostAudioProbeStatus): ReturnType<typeof vi.fn> {
  const kill = vi.fn();
  macosAudioMocks.startMacOsAudioProbeProcess.mockImplementation(
    async (options: HostAudioProbeStartOptions) => {
      await writeHostAudioProbeStatus(options.statusPath, {
        state: 'running',
        active: true,
        heard: true,
        durationMs: options.durationMs,
        elapsedMs: status.elapsedMs,
        bucketMs: options.bucketMs,
        sampleCount: status.rmsDbfs.length,
        rmsDbfs: status.rmsDbfs,
        peakDbfs: status.peakDbfs,
        notes: status.notes,
      });
      return {
        child: { kill, pid: 1234 },
        wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
      };
    },
  );
  return kill;
}

async function writeHostAudioProbeStatus(
  statusPath: string,
  data: Record<string, unknown>,
): Promise<void> {
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(
    statusPath,
    JSON.stringify({
      audio: 'probe',
      source: 'system-audio',
      backend: 'macos-screencapturekit',
      sourceCount: 1,
      ...data,
    }),
  );
}

function makeAudioWebProvider(): WebProvider & {
  probeAudio: ReturnType<typeof vi.fn<NonNullable<WebProvider['probeAudio']>>>;
} {
  const probeAudio = vi.fn<NonNullable<WebProvider['probeAudio']>>(async (options) => ({
    audio: 'probe',
    state: options.action === 'start' ? 'running' : 'stopped',
    active: options.action === 'start',
    heard: false,
    source: 'media-elements',
    backend: 'test',
    durationMs: options.durationMs ?? 10_000,
    elapsedMs: 0,
    bucketMs: options.bucketMs ?? 1_000,
    sampleCount: 0,
    mediaElementCount: 0,
    sourceCount: 0,
    rmsDbfs: [],
    peakDbfs: [],
  }));
  return {
    open: async () => {},
    close: async () => {},
    snapshot: async () => ({ nodes: [] }),
    screenshot: async () => {},
    setViewport: async () => {},
    click: async () => {},
    fill: async () => {},
    typeText: async () => {},
    scroll: async () => {},
    probeAudio,
  };
}
