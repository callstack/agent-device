/**
 * Per-attempt screen recording inside a `test` suite: the video is finalized exactly once even
 * when the request is canceled after recording started. Moved here with the command itself when
 * the test-suite command left `session-replay.ts` (AGENTS.md, tests mirror source topology).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { SessionStore } from '../../session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { makeIosSession } from '../../../__tests__/test-utils/index.ts';
import { handleSessionReplayCommands } from '../session-replay.ts';
import { mkdtempForTestSync } from '../../../__tests__/test-utils/tmp-dir.ts';
import { replayScriptSourceBundleFor } from '../../../__tests__/test-utils/replay-script-source.ts';
import {
  unavailableBindDevice,
  unavailableBindExactDevice,
} from '../../__tests__/test-device-runtime-gateway.ts';
import { createScreenRecordingAdmissionLedger } from '../../screen-recording-admission-ledger.ts';
import type { RecordRuntimeHandlerParams } from '../record-runtime.ts';
import { createDurableResourceEnvelope } from '@agent-device/capture-kit';
import {
  localRuntimeOwner,
  type ScreenRecordingLiveHandle,
} from '@agent-device/contracts/platform';

const recordRuntimeMocks = vi.hoisted(() => ({
  handleRecordCommand: vi.fn(),
}));

vi.mock('../record-runtime.ts', () => ({
  handleRecordCommand: recordRuntimeMocks.handleRecordCommand,
}));

beforeEach(() => {
  vi.useRealTimers();
  recordRuntimeMocks.handleRecordCommand.mockReset();
});

type RecordCommandCall = [RecordRuntimeHandlerParams];

type RecordVideoFixture = {
  root: string;
  replayPath: string;
  sessionStore: SessionStore;
  nestedRequests: DaemonRequest[];
  events: string[];
};

type MockRecordingState = {
  recordingPath: string;
  events: string[];
  finish: ScreenRecordingLiveHandle['finish'];
  liveSlotCleared: boolean;
};

function createRecordVideoFixture(): RecordVideoFixture {
  const root = mkdtempForTestSync('agent-device-replay-record-video-');
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "Demo"\nclick "Continue"\n');
  return {
    root,
    replayPath,
    sessionStore: new SessionStore(path.join(root, 'sessions')),
    nestedRequests: [],
    events: [],
  };
}

function installMockRecordingHandler(sessionStore: SessionStore, state: MockRecordingState): void {
  recordRuntimeMocks.handleRecordCommand.mockImplementation(
    async (params: { req: DaemonRequest }): Promise<DaemonResponse> =>
      await handleMockRecordCommand({
        req: params.req,
        sessionStore,
        state,
      }),
  );
}

async function handleMockRecordCommand(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  state: MockRecordingState;
}): Promise<DaemonResponse> {
  const { req, sessionStore, state } = params;
  const action = req.positionals?.[0];
  if (action === 'start') return startMockRecording({ req, sessionStore, state });
  if (action === 'stop') return stopMockRecording({ req, sessionStore, state });
  return { ok: false, error: { code: 'INVALID_ARGS', message: 'unexpected record action' } };
}

function startMockRecording(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  state: MockRecordingState;
}): DaemonResponse {
  const { req, sessionStore, state } = params;
  state.events.push('record:start');
  state.recordingPath = req.positionals?.[1] ?? '';
  const session = sessionStore.get(req.session);
  if (session) {
    const outPath = state.recordingPath;
    const handle: ScreenRecordingLiveHandle = {
      inspect: () => ({
        backend: 'test',
        outPath,
        startedAt: Date.now(),
        scope: 'app',
        showTouches: false,
        recordOnlySession: false,
        gestureEvents: [],
      }),
      appendGestureEvents: () => {},
      setTouchReferenceFrame: () => {},
      setRunnerSessionId: () => {},
      invalidate: () => {},
      finish: state.finish,
      forceCleanup: async () => ({ status: 'cleaned' }),
      [Symbol.asyncDispose]: async () => {},
    };
    session.screenRecording = {
      handle,
      envelope: createDurableResourceEnvelope({
        resourceKind: 'screen-recording',
        sessionId: session.name,
        device: { id: session.device.id, family: 'apple', appleOs: 'ios', kind: 'simulator' },
        owner: localRuntimeOwner('apple'),
        fence: { token: `${session.name}-fence`, generation: 1 },
        lifecycle: 'open',
        descriptor: { version: 1, body: { recordingId: session.name } },
        metadata: { phase: 'active' },
      }),
    };
    sessionStore.set(req.session, session);
  }
  return { ok: true, data: { recording: 'started', outPath: state.recordingPath } };
}

async function stopMockRecording(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  state: MockRecordingState;
}): Promise<DaemonResponse> {
  const { req, sessionStore, state } = params;
  state.events.push('record:stop');
  const session = sessionStore.get(req.session);
  if (session) {
    await session.screenRecording?.handle.finish();
    session.screenRecording = undefined;
    sessionStore.set(req.session, session);
    state.liveSlotCleared = sessionStore.get(req.session)?.screenRecording === undefined;
  }
  fs.writeFileSync(state.recordingPath, 'video');
  return {
    ok: true,
    data: {
      recording: 'stopped',
      outPath: state.recordingPath,
      artifacts: [
        {
          field: 'outPath',
          artifactType: 'screen-recording',
          path: state.recordingPath,
          fileName: path.basename(state.recordingPath),
        },
      ],
    },
  };
}

function expectRecordVideoCalls(params: {
  generatedSession: string;
  artifactsDir: string | undefined;
  admissionLedger: RecordRuntimeHandlerParams['admissionLedger'];
  requestScope: RecordRuntimeHandlerParams['requestScope'];
  throwIfCanceled: RecordRuntimeHandlerParams['throwIfCanceled'];
}): void {
  const { artifactsDir } = params;
  const [startCall, stopCall] = requireRecordVideoCalls();
  expectRecordRuntimeCall(startCall, params);
  assert.deepEqual(startCall.req.positionals, [
    'start',
    path.join(artifactsDir ?? '', 'attempt-1', 'recording.mp4'),
  ]);
  expectRecordRuntimeCall(stopCall, params);
  assert.deepEqual(stopCall.req.positionals, ['stop']);
}

function requireRecordVideoCalls(): [RecordRuntimeHandlerParams, RecordRuntimeHandlerParams] {
  const calls = recordRuntimeMocks.handleRecordCommand.mock.calls as RecordCommandCall[];
  assert.equal(calls.length, 2);
  const startCall = calls[0]?.[0];
  const stopCall = calls[1]?.[0];
  if (!startCall || !stopCall) throw new Error('Expected record start and stop calls');
  return [startCall, stopCall];
}

function expectRecordRuntimeCall(
  call: RecordRuntimeHandlerParams,
  expected: Pick<
    Parameters<typeof expectRecordVideoCalls>[0],
    'generatedSession' | 'admissionLedger' | 'requestScope' | 'throwIfCanceled'
  >,
): void {
  assert.equal(call.sessionName, expected.generatedSession);
  assert.equal(call.req.session, expected.generatedSession);
  assert.strictEqual(call.bindDevice, unavailableBindDevice);
  assert.strictEqual(call.bindExactDevice, unavailableBindExactDevice);
  assert.strictEqual(call.admissionLedger, expected.admissionLedger);
  assert.strictEqual(call.requestScope, expected.requestScope);
  assert.strictEqual(call.throwIfCanceled, expected.throwIfCanceled);
}

test('test finalizes replay video exactly once when cancellation arrives after start', async () => {
  vi.useFakeTimers({ now: 1_000 });
  const { root, replayPath, sessionStore, nestedRequests, events } = createRecordVideoFixture();
  const finish = vi.fn(async () => ({
    status: 'completed' as const,
    result: {
      backend: 'test',
      outPath: path.join(root, 'capture.mp4'),
      startedAt: 1,
      completedAt: 2,
      scope: 'app' as const,
      showTouches: false,
      recordOnlySession: false,
    },
  }));
  const recordingState: MockRecordingState = {
    recordingPath: '',
    events,
    finish,
    liveSlotCleared: false,
  };
  installMockRecordingHandler(sessionStore, recordingState);
  const screenRecordingAdmissionLedger = createScreenRecordingAdmissionLedger();
  const requestScope = {
    signal: new AbortController().signal,
    diagnostics: { emit: () => {} },
    progress: { report: () => {} },
  };
  const cancellation = new Error('request canceled after recording start');
  const throwIfCanceled = vi
    .fn<() => void>()
    .mockImplementationOnce(() => {})
    .mockImplementation(() => {
      throw cancellation;
    });

  const responsePromise = handleSessionReplayCommands({
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [replayPath],
      flags: {
        recordVideo: true,
        replayKeepSession: false,
        saveScript: false,
        force: false,
        artifactsDir: path.join(root, 'artifacts'),
        replayScriptSources: [replayScriptSourceBundleFor(replayPath)],
      },
      meta: { cwd: root, requestId: 'record-video-suite' },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    bindDevice: unavailableBindDevice,
    bindExactDevice: unavailableBindExactDevice,
    screenRecordingAdmissionLedger,
    requestScope,
    retainDeviceExecutionLock: async () => {},
    throwIfCanceled,
    invoke: async (nestedReq) => {
      nestedRequests.push(nestedReq);
      if (nestedReq.command === 'open') {
        const provisionalSession = makeIosSession(nestedReq.session);
        sessionStore.set(nestedReq.session, provisionalSession);
        const hookResponse =
          await nestedReq.internal?.openLifecycle?.beforeDispatch?.(provisionalSession);
        if (hookResponse && !hookResponse.ok) return hookResponse;
        events.push('open:dispatch');
      }
      return { ok: true, data: { session: nestedReq.session } };
    },
  });
  await vi.advanceTimersByTimeAsync(4_000);
  const response = await responsePromise;
  vi.useRealTimers();

  if (!response) throw new Error('Expected response');
  if (!response.ok) throw new Error(response.error.message);
  const suite = response.data as {
    tests?: Array<{ session?: string; artifactsDir?: string }>;
  };
  const testResult = suite.tests?.[0] ?? {};
  const generatedSession = testResult.session;
  if (typeof generatedSession !== 'string') throw new Error('Expected generated test session');
  expectRecordVideoCalls({
    generatedSession,
    artifactsDir: testResult.artifactsDir,
    admissionLedger: screenRecordingAdmissionLedger,
    requestScope,
    throwIfCanceled,
  });
  assert.equal(throwIfCanceled.mock.calls.length, 1);
  assert.equal(finish.mock.calls.length, 1);
  assert.equal(recordingState.liveSlotCleared, true);
  assert.deepEqual(events, ['record:start', 'open:dispatch', 'record:stop']);
  const timingPath = path.join(testResult.artifactsDir ?? '', 'attempt-1', 'replay-timing.ndjson');
  const timingEvents = fs
    .readFileSync(timingPath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type?: string });
  assert.deepEqual(
    timingEvents.map((event) => event.type).filter((type) => type?.startsWith('video_')),
    ['video_recording_start', 'video_preroll_done', 'video_tail_start', 'video_recording_stop'],
  );
  assert.equal(
    nestedRequests.some((nestedReq) => nestedReq.flags?.recordVideo === true),
    false,
  );
});
