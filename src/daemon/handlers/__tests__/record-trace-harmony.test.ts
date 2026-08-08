import assert from 'node:assert/strict';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return { ...actual, runCmd: vi.fn() };
});

vi.mock('../../../utils/video.ts', () => ({
  waitForStableFile: vi.fn(async () => {}),
  isPlayableVideo: vi.fn(async () => true),
}));

import { runCmd } from '../../../utils/exec.ts';
import { isPlayableVideo } from '../../../utils/video.ts';
import { SessionStore } from '../../session-store.ts';
import type { DaemonRequest, SessionState } from '../../types.ts';
import { handleRecordTraceCommands } from '../record-trace.ts';
import { parseHarmonyFileSize, parseHarmonyMediaUri } from '../record-trace-harmony.ts';

const mockRunCmd = vi.mocked(runCmd);
const mockIsPlayableVideo = vi.mocked(isPlayableVideo);

function makeStore(): SessionStore {
  return new SessionStore(
    path.join(mkdtempForTestSync('agent-device-harmony-record-'), 'sessions'),
  );
}

function makeSession(kind: 'device' | 'emulator' = 'device'): SessionState {
  return {
    name: 'harmony-record',
    device: {
      platform: 'harmonyos',
      id: `harmony-${kind}-1`,
      name: `Harmony ${kind}`,
      kind,
      target: 'mobile',
      booted: true,
    },
    createdAt: Date.now(),
    actions: [],
  };
}

function request(action: 'start' | 'stop', outPath?: string): DaemonRequest {
  return {
    token: 'test',
    session: 'harmony-record',
    command: 'record',
    positionals: [action, ...(outPath ? [outPath] : [])],
    flags: { recordingScope: 'device' },
  };
}

function assertHdcCommand(calls: unknown[][], tokens: string[], message: string): void {
  assert.ok(
    calls.some((args) => tokens.every((token) => args.includes(token))),
    message,
  );
}

type RecordingResponseData = {
  recording?: string;
  recordingBackend?: string;
  outPath?: string;
};

function requireRecordingResponse(
  response: Awaited<ReturnType<typeof handleRecordTraceCommands>>,
): RecordingResponseData {
  if (!response) {
    assert.fail('Expected a recording response');
  }
  if (!response.ok) {
    assert.fail(response.error.message);
  }
  return response.data as RecordingResponseData;
}

function recordingPlatform(store: SessionStore, sessionName: string): string | undefined {
  return store.get(sessionName)?.recording?.platform;
}

beforeEach(() => {
  mockRunCmd.mockReset();
  mockIsPlayableVideo.mockReset();
  mockIsPlayableVideo.mockResolvedValue(true);
  mockRunCmd.mockImplementation(async (_command, args) => {
    if (args.includes('query')) {
      return {
        exitCode: 0,
        stdout: 'find 1 result\nuri\n"file://media/Photo/1/VID_1/recording.mp4"\n',
        stderr: '',
      } as Awaited<ReturnType<typeof runCmd>>;
    }
    if (args.includes('ls')) {
      return {
        exitCode: 0,
        stdout: '-rw-r--r-- 1 shell shell 1234 2026-08-08 12:00 /data/local/tmp/recording.mp4\n',
        stderr: '',
      } as Awaited<ReturnType<typeof runCmd>>;
    }
    return { exitCode: 0, stdout: 'start ability successfully.\n', stderr: '' } as Awaited<
      ReturnType<typeof runCmd>
    >;
  });
});

test('parseHarmonyMediaUri extracts a quoted media-library URI', () => {
  assert.equal(
    parseHarmonyMediaUri('find 1 result\nuri\n"file://media/Photo/1/VID_1/clip.mp4"'),
    'file://media/Photo/1/VID_1/clip.mp4',
  );
  assert.equal(parseHarmonyMediaUri('find 0 result'), undefined);
});

test('parseHarmonyFileSize accepts non-empty shell ls output only', () => {
  assert.equal(
    parseHarmonyFileSize('-rw-r--r-- 1 shell shell 1234 2026-08-08 12:00 /data/local/tmp/clip.mp4'),
    1234,
  );
  assert.equal(parseHarmonyFileSize(''), undefined);
});

test('physical HarmonyOS recording starts, retrieves a playable MP4, and cleans device artifacts', async () => {
  const store = makeStore();
  const session = makeSession();
  store.set(session.name, session);
  const outPath = path.join(mkdtempForTestSync('agent-device-harmony-video-'), 'capture.mp4');

  const started = await handleRecordTraceCommands({
    req: request('start', outPath),
    sessionName: session.name,
    sessionStore: store,
  });
  const startedData = requireRecordingResponse(started);
  assert.equal(startedData.recording, 'started');
  assert.equal(startedData.recordingBackend, 'HarmonyOS ScreenRecorder');
  assert.equal(recordingPlatform(store, session.name), 'harmonyos');

  const stopped = await handleRecordTraceCommands({
    req: request('stop'),
    sessionName: session.name,
    sessionStore: store,
  });
  const stoppedData = requireRecordingResponse(stopped);
  assert.equal(stoppedData.recording, 'stopped');
  assert.equal(stoppedData.outPath, outPath);
  assert.equal(store.get(session.name)?.recording, undefined);
  assert.equal(mockIsPlayableVideo.mock.calls[0]![0], outPath);

  const hdcCalls = mockRunCmd.mock.calls.map(([, args]) => args);
  assertHdcCommand(
    hdcCalls,
    ['CustomizedFileName'],
    'start passes the unique media-library filename to ScreenRecorder',
  );
  assertHdcCommand(
    hdcCalls,
    ['mediatool', 'recv'],
    'stop exports media-library content to the temporary device path',
  );
  assertHdcCommand(hdcCalls, ['file', 'recv'], 'stop retrieves the MP4 through HDC file transfer');
  assertHdcCommand(
    hdcCalls,
    ['mediatool', 'delete'],
    'successful retrieval deletes the media-library entry',
  );
});

test('HarmonyOS recording rejects app scope and simulator devices before HDC is invoked', async () => {
  const physicalStore = makeStore();
  const physical = makeSession();
  physicalStore.set(physical.name, physical);
  const appScope = await handleRecordTraceCommands({
    req: { ...request('start'), flags: {} },
    sessionName: physical.name,
    sessionStore: physicalStore,
  });
  assert.equal(appScope?.ok, false);
  assert.match(appScope?.error?.message ?? '', /whole physical-device screen/);

  const emulatorStore = makeStore();
  const emulator = makeSession('emulator');
  emulatorStore.set(emulator.name, emulator);
  const emulatorResponse = await handleRecordTraceCommands({
    req: request('start'),
    sessionName: emulator.name,
    sessionStore: emulatorStore,
  });
  assert.equal(emulatorResponse?.ok, false);
  assert.equal(emulatorResponse?.error?.code, 'UNSUPPORTED_OPERATION');
  assert.equal(mockRunCmd.mock.calls.length, 0);
});
