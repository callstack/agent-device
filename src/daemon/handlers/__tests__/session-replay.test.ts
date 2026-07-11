import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, test, vi } from 'vitest';
import { SessionStore } from '../../session-store.ts';
import { LeaseRegistry } from '../../lease-registry.ts';
import type { DaemonRequest, DaemonResponse } from '../../types.ts';
import { makeIosSession } from '../../../__tests__/test-utils/index.ts';
import { buildNestedReplayFlags, handleSessionReplayCommands } from '../session-replay.ts';

const recordTraceMocks = vi.hoisted(() => ({
  handleRecordCommand: vi.fn(),
}));

vi.mock('../record-trace-recording.ts', () => ({
  handleRecordCommand: recordTraceMocks.handleRecordCommand,
}));

beforeEach(() => {
  vi.useRealTimers();
  recordTraceMocks.handleRecordCommand.mockReset();
});

type RecordCommandCall = [{ req: DaemonRequest; sessionName: string }];

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
};

function createRecordVideoFixture(): RecordVideoFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-replay-record-video-'));
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
  recordTraceMocks.handleRecordCommand.mockImplementation(
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
    session.recording = {
      platform: 'ios',
      outPath: state.recordingPath,
      startedAt: Date.now(),
      showTouches: true,
      gestureEvents: [],
      child: { kill: () => true, pid: 123 },
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    } as NonNullable<typeof session.recording>;
    sessionStore.set(req.session, session);
  }
  return { ok: true, data: { recording: 'started', outPath: state.recordingPath } };
}

function stopMockRecording(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  state: MockRecordingState;
}): DaemonResponse {
  const { req, sessionStore, state } = params;
  state.events.push('record:stop');
  const session = sessionStore.get(req.session);
  if (session) {
    session.recording = undefined;
    sessionStore.set(req.session, session);
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
}): void {
  const { generatedSession, artifactsDir } = params;
  const recordCalls = recordTraceMocks.handleRecordCommand.mock.calls as RecordCommandCall[];
  assert.equal(recordCalls.length, 2);

  const startCall = recordCalls[0]?.[0];
  const stopCall = recordCalls[1]?.[0];
  assert.equal(startCall?.sessionName, generatedSession);
  assert.equal(startCall?.req.session, generatedSession);
  assert.deepEqual(startCall?.req.positionals, [
    'start',
    path.join(artifactsDir ?? '', 'attempt-1', 'recording.mp4'),
  ]);
  assert.equal(stopCall?.sessionName, generatedSession);
  assert.equal(stopCall?.req.session, generatedSession);
  assert.deepEqual(stopCall?.req.positionals, ['stop']);
}

test('buildNestedReplayFlags returns parent flags untouched when neither override is set', () => {
  const parent = { platform: 'android' as const, timeoutMs: 5000 };
  const result = buildNestedReplayFlags({
    parentFlags: parent,
    platform: undefined,
    target: undefined,
    artifactsDir: undefined,
  });
  assert.strictEqual(result, parent);
});

test('buildNestedReplayFlags merges platform, target, and artifactsDir into parent flags', () => {
  const parent = { timeoutMs: 5000, retries: 1 };
  const result = buildNestedReplayFlags({
    parentFlags: parent,
    platform: 'ios',
    target: 'mobile',
    artifactsDir: '/tmp/attempt-1',
  });
  assert.deepEqual(result, {
    timeoutMs: 5000,
    retries: 1,
    platform: 'ios',
    target: 'mobile',
    artifactsDir: '/tmp/attempt-1',
  });
  // Parent object must not be mutated.
  assert.equal((parent as Record<string, unknown>).artifactsDir, undefined);
});

test('buildNestedReplayFlags threads artifactsDir through even when parent lacks it', () => {
  const result = buildNestedReplayFlags({
    parentFlags: undefined,
    platform: undefined,
    target: undefined,
    artifactsDir: '/tmp/attempt-1',
  });
  assert.deepEqual(result, { artifactsDir: '/tmp/attempt-1' });
});

test('buildNestedReplayFlags overrides a parent artifactsDir with the attempt-level one', () => {
  const result = buildNestedReplayFlags({
    parentFlags: { artifactsDir: '/suite-root' },
    platform: undefined,
    target: undefined,
    artifactsDir: '/suite-root/flow/attempt-2',
  });
  assert.equal(result?.artifactsDir, '/suite-root/flow/attempt-2');
});

test('buildNestedReplayFlags strips test-only recordVideo before replay actions inherit flags', () => {
  const result = buildNestedReplayFlags({
    parentFlags: { platform: 'ios', recordVideo: true },
    platform: undefined,
    target: undefined,
    artifactsDir: undefined,
  });

  assert.deepEqual(result, { platform: 'ios' });
});

test('test --record-video records each replay attempt on the generated test session', async () => {
  vi.useFakeTimers({ now: 1_000 });
  const { root, replayPath, sessionStore, nestedRequests, events } = createRecordVideoFixture();
  installMockRecordingHandler(sessionStore, { recordingPath: '', events });

  const responsePromise = handleSessionReplayCommands({
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [replayPath],
      flags: { recordVideo: true, artifactsDir: path.join(root, 'artifacts') },
      meta: { cwd: root, requestId: 'record-video-suite' },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
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
  expectRecordVideoCalls({ generatedSession, artifactsDir: testResult.artifactsDir });
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

// --- ADR 0012 decision 4 / migration step 5: `--from` is replay-only ---

test('test rejects --from with INVALID_ARGS before running the suite', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-from-rejected-'));
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "Demo"\nclick "Continue"\n');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));

  const response = await handleSessionReplayCommands({
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [replayPath],
      flags: { replayFrom: 2, replayPlanDigest: 'deadbeef' },
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    invoke: async () => {
      throw new Error('test must not start executing when --from is rejected');
    },
  });

  if (!response) throw new Error('Expected response');
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'INVALID_ARGS');
  assert.match(response.error.message, /--from/);
});

test('test rejects --plan-digest alone with INVALID_ARGS before running the suite', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-test-digest-rejected-'));
  const replayPath = path.join(root, 'flow.ad');
  fs.writeFileSync(replayPath, 'open "Demo"\nclick "Continue"\n');
  const sessionStore = new SessionStore(path.join(root, 'sessions'));

  const response = await handleSessionReplayCommands({
    req: {
      token: 'token',
      session: 'default',
      command: 'test',
      positionals: [replayPath],
      flags: { replayPlanDigest: 'deadbeef' },
      meta: { cwd: root },
    },
    sessionName: 'default',
    logPath: path.join(root, 'daemon.log'),
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    invoke: async () => {
      throw new Error('test must not start executing when --plan-digest is rejected');
    },
  });

  if (!response) throw new Error('Expected response');
  assert.equal(response.ok, false);
  if (response.ok) return;
  assert.equal(response.error.code, 'INVALID_ARGS');
});
