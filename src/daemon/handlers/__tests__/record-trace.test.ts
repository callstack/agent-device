import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../../utils/exec.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/exec.ts')>();
  return {
    ...actual,
    runCmd: vi.fn(async () => ({ stdout: '', stderr: '', exitCode: 0 })),
    runCmdBackground: vi.fn(() => ({
      child: { kill: vi.fn() },
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    })),
  };
});

vi.mock('../../../platforms/apple/core/runner/runner-client.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/runner/runner-client.ts')>();
  return {
    ...actual,
    runAppleRunnerCommand: vi.fn(async () => ({})),
  };
});

vi.mock('../../../utils/video.ts', () => ({
  waitForStableFile: vi.fn(async () => {}),
  isPlayableVideo: vi.fn(async () => true),
}));

vi.mock('../../../recording/overlay.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../recording/overlay.ts')>();
  return {
    ...actual,
    trimRecordingStart: vi.fn(async () => {}),
    resizeRecording: vi.fn(async () => {}),
    overlayRecordingTouches: vi.fn(async () => {}),
  };
});

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    resolveTargetDevice: vi.fn(async () => {
      throw new Error('resolveTargetDevice should not run');
    }),
  };
});

vi.mock('../../device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));

import { handleRecordTraceCommands } from '../record-trace.ts';
import { deriveRecordingTelemetryPath } from '../../recording-telemetry.ts';
import { SessionStore } from '../../session-store.ts';
import type { SessionState } from '../../types.ts';
import { runAppleRunnerCommand } from '../../../platforms/apple/core/runner/runner-client.ts';
import {
  getRecordingOverlaySupportWarning,
  resizeRecording,
  trimRecordingStart,
  overlayRecordingTouches,
} from '../../../recording/overlay.ts';
import { resolveTargetDevice } from '../../../core/dispatch.ts';
import { runCmd, runCmdBackground } from '../../../utils/exec.ts';
import { isPlayableVideo, waitForStableFile } from '../../../utils/video.ts';
import { withWebProvider, type WebProvider } from '../../../platforms/web/provider.ts';

type RunnerCall = {
  command: string;
  outPath?: string;
  fps?: number;
  maxSize?: number;
  appBundleId?: string;
  logPath?: string;
  traceLogPath?: string;
};

const mockRunCmd = vi.mocked(runCmd);
const mockRunCmdBackground = vi.mocked(runCmdBackground);
const mockRunAppleRunnerCommand = vi.mocked(runAppleRunnerCommand);
const mockResolveTargetDevice = vi.mocked(resolveTargetDevice);
const mockResizeRecording = vi.mocked(resizeRecording);
const mockTrimRecordingStart = vi.mocked(trimRecordingStart);
const mockOverlayRecordingTouches = vi.mocked(overlayRecordingTouches);
const mockWaitForStableFile = vi.mocked(waitForStableFile);
const mockIsPlayableVideo = vi.mocked(isPlayableVideo);

const overlaySupportWarning = getRecordingOverlaySupportWarning();

function makeSessionStore(): SessionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-record-trace-'));
  return new SessionStore(path.join(root, 'sessions'));
}

function makeSession(name: string, device: SessionState['device']): SessionState {
  return {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
  };
}

function makeIosDeviceSession(name: string, appBundleId?: string): SessionState {
  const session = makeSession(name, {
    platform: 'apple',
    id: 'ios-device-1',
    name: 'My iPhone',
    kind: 'device',
    booted: true,
  });
  if (appBundleId) {
    session.appBundleId = appBundleId;
  }
  return session;
}

function makeIosSimulatorSession(name: string): SessionState {
  return makeSession(name, {
    platform: 'apple',
    id: 'ios-sim-1',
    name: 'iPhone 16',
    kind: 'simulator',
    booted: true,
  });
}

function makeWebSession(name: string): SessionState {
  return makeSession(name, {
    platform: 'web',
    id: 'agent-browser-chrome',
    name: 'Agent Browser Chrome',
    kind: 'device',
    target: 'desktop',
    booted: true,
  });
}

function makeWebProvider(overrides: Partial<WebProvider> = {}): WebProvider {
  return {
    open: async () => {},
    close: async () => {},
    startRecording: async () => {},
    stopRecording: async () => {},
    snapshot: async () => ({ nodes: [] }),
    screenshot: async () => {},
    setViewport: async () => {},
    click: async () => {},
    fill: async () => {},
    typeText: async () => {},
    scroll: async () => {},
    ...overrides,
  };
}

function makeIosSimulatorRecordingSession(
  name: string,
  options: {
    appBundleId?: string;
    outPath?: string;
    recordOnlySession?: boolean;
    startedAt?: number;
  } = {},
): SessionState {
  const session = makeIosSimulatorSession(name);
  if (options.appBundleId) {
    session.appBundleId = options.appBundleId;
  }
  if (options.recordOnlySession) {
    session.recordOnlySession = true;
  }
  session.recording = {
    platform: 'ios',
    child: { kill: vi.fn(), pid: 123 },
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    outPath: options.outPath ?? path.join(os.tmpdir(), `${name}.mp4`),
    startedAt: options.startedAt ?? Date.now(),
    showTouches: false,
    gestureEvents: [],
  };
  return session;
}

async function runRecordCommand(params: {
  sessionStore: SessionStore;
  sessionName: string;
  positionals: string[];
  logPath?: string;
  cwd?: string;
  flags?: {
    fps?: number;
    quality?: string;
    screenshotMaxSize?: number;
    hideTouches?: boolean;
  };
  clientArtifactPaths?: Record<string, string>;
}) {
  return handleRecordTraceCommands({
    req: {
      token: 't',
      session: params.sessionName,
      command: 'record',
      positionals: params.positionals,
      flags: params.flags ?? {},
      meta:
        params.cwd || params.clientArtifactPaths
          ? {
              ...(params.cwd ? { cwd: params.cwd } : {}),
              ...(params.clientArtifactPaths
                ? { clientArtifactPaths: params.clientArtifactPaths }
                : {}),
            }
          : undefined,
    },
    sessionName: params.sessionName,
    sessionStore: params.sessionStore,
    logPath: params.logPath,
  });
}

function setupRunnerRecordingMocks(
  runnerCalls: RunnerCall[],
  runCmdCalls: Array<{ cmd: string; args: string[] }>,
): void {
  mockRunAppleRunnerCommand.mockImplementation(async (_device, command, options) => {
    runnerCalls.push({
      command: command.command,
      outPath: command.outPath,
      fps: command.fps,
      maxSize: command.maxSize,
      appBundleId: command.appBundleId,
      logPath: options?.logPath,
      traceLogPath: options?.traceLogPath,
    });
    if (command.command === 'recordStart') {
      return { recorderStartUptimeMs: 12_345, targetAppReadyUptimeMs: 15_678 };
    }
    return {};
  });
  mockRunCmd.mockImplementation(async (cmd, args) => {
    runCmdCalls.push({ cmd, args });
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  mockRunCmdBackground.mockImplementation(() => {
    throw new Error('runCmdBackground should not be used for runner-backed recording');
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Restore default implementations
  mockRunCmd.mockImplementation(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
  mockRunCmdBackground.mockImplementation(() => {
    throw new Error('runCmdBackground should not be used in this test');
  });
  mockRunAppleRunnerCommand.mockImplementation(async () => ({}));
  mockResizeRecording.mockImplementation(async () => {});
  mockTrimRecordingStart.mockImplementation(async () => {});
  mockOverlayRecordingTouches.mockImplementation(async () => {});
  mockWaitForStableFile.mockImplementation(async () => {});
  mockIsPlayableVideo.mockImplementation(async () => true);
});

afterEach(() => {
  vi.useRealTimers();
});

test('record stop derives telemetry artifact local path from client outPath', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-remote-artifacts';
  const session = makeIosDeviceSession(sessionName, 'com.atebits.Tweetie2');
  sessionStore.set(sessionName, session);

  const runnerCalls: RunnerCall[] = [];
  const runCmdCalls: Array<{ cmd: string; args: string[] }> = [];
  setupRunnerRecordingMocks(runnerCalls, runCmdCalls);
  const finalOut = path.join(os.tmpdir(), `agent-device-test-record-${Date.now()}.mp4`);

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', finalOut],
    clientArtifactPaths: { outPath: finalOut },
  });

  const responseStop = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(responseStop?.ok).toBe(true);
  expect((responseStop as any).data?.artifacts?.[1]?.field).toBe('telemetryPath');
  expect((responseStop as any).data?.artifacts?.[1]?.localPath).toBe(
    deriveRecordingTelemetryPath(finalOut),
  );
  expect((responseStop as any).data?.telemetryPath).toBe(deriveRecordingTelemetryPath(finalOut));
});

test('record stop releases session created only for recording', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'record-only-session';
  const session = makeIosSimulatorRecordingSession(sessionName, { recordOnlySession: true });
  sessionStore.set(sessionName, session);

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(true);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('record stop keeps normal app session open when stop validation fails', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(20_000);
  const sessionStore = makeSessionStore();
  const sessionName = 'app-session-failed-stop';
  const outPath = path.join(os.tmpdir(), 'app-session-failed-stop.mp4');
  fs.writeFileSync(outPath, 'not playable');
  const session = makeIosSimulatorRecordingSession(sessionName, {
    appBundleId: 'com.apple.Preferences',
    outPath,
    startedAt: Date.now() - 500,
  });
  sessionStore.set(sessionName, session);
  mockIsPlayableVideo.mockImplementation(async () => false);

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(false);
  expect(sessionStore.get(sessionName)).toBe(session);
  expect(sessionStore.get(sessionName)?.recording).toBeUndefined();
});

test('record start and stop web recording keep the requested artifact path stable', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'web-recording-stable-path';
  const session = makeWebSession(sessionName);
  sessionStore.set(sessionName, session);
  const outPath = path.join(os.tmpdir(), `${sessionName}.webm`);
  const calls: string[] = [];
  const provider = makeWebProvider({
    startRecording: async (path) => {
      calls.push(`start:${path}`);
    },
    stopRecording: async () => {
      calls.push('stop');
      fs.writeFileSync(outPath, 'webm');
    },
  });

  try {
    await withWebProvider(provider, async () => {
      const start = await runRecordCommand({
        sessionStore,
        sessionName,
        positionals: ['start', outPath],
      });
      const stop = await runRecordCommand({
        sessionStore,
        sessionName,
        positionals: ['stop'],
      });

      expect(start?.ok).toBe(true);
      expect((start as any).data?.outPath).toBe(outPath);
      expect(stop?.ok).toBe(true);
      expect((stop as any).data?.outPath).toBe(outPath);
      expect((stop as any).data?.artifacts?.[0]?.path).toBe(outPath);
    });
    expect(calls).toEqual([`start:${outPath}`, 'stop']);
  } finally {
    fs.rmSync(outPath, { force: true });
  }
});

test('record start web appends .webm to extensionless paths before delegating', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'web-recording-extensionless';
  const session = makeWebSession(sessionName);
  sessionStore.set(sessionName, session);
  const requestedPath = path.join(os.tmpdir(), sessionName);
  const expectedPath = `${requestedPath}.webm`;
  const calls: string[] = [];
  const provider = makeWebProvider({
    startRecording: async (path) => {
      calls.push(path);
      fs.writeFileSync(path, 'webm');
    },
  });

  try {
    await withWebProvider(provider, async () => {
      const start = await runRecordCommand({
        sessionStore,
        sessionName,
        positionals: ['start', requestedPath],
      });

      expect(start?.ok).toBe(true);
      expect((start as any).data?.outPath).toBe(expectedPath);
    });
    expect(calls).toEqual([expectedPath]);
  } finally {
    fs.rmSync(expectedPath, { force: true });
  }
});

test('record start web rejects non-WebM output paths before delegating', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'web-recording-mp4';
  const session = makeWebSession(sessionName);
  sessionStore.set(sessionName, session);
  const provider = makeWebProvider({
    startRecording: async () => {
      throw new Error('should not delegate invalid web recording path');
    },
  });

  await withWebProvider(provider, async () => {
    const start = await runRecordCommand({
      sessionStore,
      sessionName,
      positionals: ['start', path.join(os.tmpdir(), `${sessionName}.mp4`)],
    });

    expect(start?.ok).toBe(false);
    if (!start || start.ok) {
      throw new Error(`expected web recording start failure, got ${JSON.stringify(start)}`);
    }
    expect(start.error.code).toBe('INVALID_ARGS');
    expect(start.error.message).toMatch(/\.webm output path/);
  });
});

test('record start web rejects native recording flags before delegating', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'web-recording-native-flags';
  const session = makeWebSession(sessionName);
  sessionStore.set(sessionName, session);
  const provider = makeWebProvider({
    startRecording: async () => {
      throw new Error('should not delegate unsupported web recording flags');
    },
  });

  await withWebProvider(provider, async () => {
    const start = await runRecordCommand({
      sessionStore,
      sessionName,
      positionals: ['start', path.join(os.tmpdir(), `${sessionName}.webm`)],
      flags: { fps: 0, quality: 'high', screenshotMaxSize: 1024, hideTouches: true },
    });

    expect(start?.ok).toBe(false);
    if (!start || start.ok) {
      throw new Error(`expected web recording start failure, got ${JSON.stringify(start)}`);
    }
    expect(start.error.code).toBe('INVALID_ARGS');
    expect(start.error.message).toContain('--fps, --quality, --max-size, --hide-touches');
  });
});

test('record start web requires an existing browser session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'web-recording-no-open';
  mockResolveTargetDevice.mockResolvedValueOnce({
    platform: 'web',
    id: 'agent-browser-chrome',
    name: 'Agent Browser Chrome',
    kind: 'device',
    target: 'desktop',
    booted: true,
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', path.join(os.tmpdir(), `${sessionName}.webm`)],
  });

  expect(response?.ok).toBe(false);
  if (!response || response.ok) {
    throw new Error(`expected web recording start failure, got ${JSON.stringify(response)}`);
  }
  expect(response.error.code).toBe('INVALID_ARGS');
  expect(response.error.message).toMatch(/run open <url> --platform web first/);
  expect(sessionStore.get(sessionName)).toBeUndefined();
});

test('record stop closes record-only web sessions during cleanup', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'web-recording-record-only-cleanup';
  const session = makeWebSession(sessionName);
  session.recordOnlySession = true;
  const outPath = path.join(os.tmpdir(), `${sessionName}.webm`);
  session.recording = {
    platform: 'web',
    outPath,
    startedAt: Date.now(),
    showTouches: false,
    gestureEvents: [],
  };
  sessionStore.set(sessionName, session);
  const calls: string[] = [];
  const provider = makeWebProvider({
    close: async () => {
      calls.push('close');
    },
    stopRecording: async () => {
      calls.push('stop');
      fs.writeFileSync(outPath, 'webm');
    },
  });

  try {
    await withWebProvider(provider, async () => {
      const response = await runRecordCommand({
        sessionStore,
        sessionName,
        positionals: ['stop'],
      });

      expect(response?.ok).toBe(true);
    });
    expect(calls).toEqual(['stop', 'close']);
    expect(sessionStore.get(sessionName)).toBeUndefined();
  } finally {
    fs.rmSync(outPath, { force: true });
  }
});

test('record stop rejects web recording when agent-browser does not finalize the file', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'web-recording-missing-file';
  const session = makeWebSession(sessionName);
  sessionStore.set(sessionName, session);
  const outPath = path.join(os.tmpdir(), `${sessionName}.webm`);
  const provider = makeWebProvider();

  try {
    await withWebProvider(provider, async () => {
      const start = await runRecordCommand({
        sessionStore,
        sessionName,
        positionals: ['start', outPath],
      });
      const stop = await runRecordCommand({
        sessionStore,
        sessionName,
        positionals: ['stop'],
      });

      expect(start?.ok).toBe(true);
      expect(stop?.ok).toBe(false);
      if (!stop || stop.ok) {
        throw new Error(`expected web recording stop failure, got ${JSON.stringify(stop)}`);
      }
      expect(stop.error.message).toMatch(/not finalized into a WebM video/);
      expect(fs.existsSync(outPath)).toBe(false);
    });
  } finally {
    fs.rmSync(outPath, { force: true });
  }
});

test('record start resolves relative output path from request cwd', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-cwd';
  const session = makeIosDeviceSession(sessionName, 'com.atebits.Tweetie2');
  sessionStore.set(sessionName, session);

  const runnerCalls: RunnerCall[] = [];
  const runCmdCalls: Array<{ cmd: string; args: string[] }> = [];
  setupRunnerRecordingMocks(runnerCalls, runCmdCalls);
  const cwd = '/tmp/agent-device-cwd-test';
  const responseStart = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './device.mp4'],
    cwd,
  });

  expect(responseStart?.ok).toBe(true);
  expect(runnerCalls[0]?.outPath ?? '').toMatch(/^agent-device-recording-\d+\.mp4$/);
  expect(runnerCalls[0]?.fps).toBeUndefined();
  const startedRecording = sessionStore.get(sessionName)?.recording;
  expect(startedRecording?.platform).toBe('ios-device-runner');
  if (startedRecording?.platform === 'ios-device-runner') {
    expect(startedRecording.outPath).toBe(path.join(cwd, 'device.mp4'));
    expect(startedRecording.remotePath ?? '').toMatch(/^tmp\/agent-device-recording-\d+\.mp4$/);
  }

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
    cwd,
  });
  expect(runCmdCalls.length).toBe(1);
});

test('record start rejects invalid fps value', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-invalid-fps';
  sessionStore.set(sessionName, makeIosDeviceSession(sessionName));

  mockRunAppleRunnerCommand.mockImplementation(async () => {
    throw new Error('runAppleRunnerCommand should not be used for invalid args');
  });
  mockRunCmdBackground.mockImplementation(() => {
    throw new Error('runCmdBackground should not be used for invalid args');
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './device.mp4'],
    flags: { fps: 0 },
  });

  expect(response?.ok).toBe(false);
  expect((response as any).error?.code).toBe('INVALID_ARGS');
  expect((response as any).error?.message ?? '').toMatch(
    /fps must be an integer between 1 and 120/,
  );
});

test('record start rejects invalid quality value', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-invalid-quality';
  sessionStore.set(sessionName, makeIosDeviceSession(sessionName));

  mockRunAppleRunnerCommand.mockImplementation(async () => {
    throw new Error('runAppleRunnerCommand should not be used for invalid args');
  });
  mockRunCmdBackground.mockImplementation(() => {
    throw new Error('runCmdBackground should not be used for invalid args');
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './device.mp4'],
    flags: { quality: 'ultra' as never },
  });

  expect(response?.ok).toBe(false);
  expect((response as any).error?.code).toBe('INVALID_ARGS');
  expect((response as any).error?.message ?? '').toMatch(/quality must be one of: medium, high/);
});

test('record start on iOS device requires active app session context', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-no-app';
  sessionStore.set(sessionName, makeIosDeviceSession(sessionName));

  mockRunAppleRunnerCommand.mockImplementation(async () => {
    throw new Error('runAppleRunnerCommand should not be used without active app context');
  });
  mockRunCmdBackground.mockImplementation(() => {
    throw new Error('runCmdBackground should not be used for iOS devices');
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './device.mp4'],
  });

  expect(response?.ok).toBe(false);
  expect((response as any).error?.code).toBe('INVALID_ARGS');
  expect((response as any).error?.message ?? '').toMatch(/requires an active app session/i);
});

test('record start returns structured error when iOS runner start fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-start-fail';
  const session = makeIosDeviceSession(sessionName, 'com.atebits.Tweetie2');
  sessionStore.set(sessionName, session);

  mockRunAppleRunnerCommand.mockImplementation(async () => {
    throw new Error('runner disconnected');
  });
  mockRunCmdBackground.mockImplementation(() => {
    throw new Error('runCmdBackground should not be used for iOS devices');
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './device.mp4'],
  });

  expect(response?.ok).toBe(false);
  expect((response as any).error?.code).toBe('COMMAND_FAILED');
  expect((response as any).error?.message ?? '').toMatch(
    /failed to start recording: runner disconnected/,
  );
  expect(sessionStore.get(sessionName)?.recording).toBeUndefined();
});

test('record start recovers from stale iOS runner recording state', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-runner-desync';
  const session = makeIosDeviceSession(sessionName, 'com.atebits.Tweetie2');
  sessionStore.set(sessionName, session);

  const commands: string[] = [];
  let startAttempts = 0;
  mockRunAppleRunnerCommand.mockImplementation(async (_device, command) => {
    commands.push(command.command);
    if (command.command === 'recordStart') {
      startAttempts += 1;
      if (startAttempts === 1) {
        throw new Error('recording already in progress');
      }
    }
    return { recorderStartUptimeMs: 11_000, targetAppReadyUptimeMs: 12_000 };
  });
  mockRunCmdBackground.mockImplementation(() => {
    throw new Error('runCmdBackground should not be used for iOS devices');
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './device.mp4'],
  });

  expect(response?.ok).toBe(true);
  expect(commands).toEqual(['recordStart', 'recordStop', 'recordStart']);
  expect(sessionStore.get(sessionName)?.recording?.platform).toBe('ios-device-runner');
});

test('record start does not stop recording owned by another session during desync recovery', async () => {
  const sessionStore = makeSessionStore();
  const ownerSessionName = 'ios-device-owner';
  const ownerSession = makeIosDeviceSession(ownerSessionName, 'com.example.owner');
  ownerSession.recording = {
    platform: 'ios-device-runner',
    outPath: '/tmp/owner.mp4',
    remotePath: 'tmp/owner.mp4',
    startedAt: Date.now(),
    showTouches: false,
    gestureEvents: [],
  };
  sessionStore.set(ownerSessionName, ownerSession);

  const sessionName = 'ios-device-requester';
  const requesterSession = makeIosDeviceSession(sessionName, 'com.example.requester');
  sessionStore.set(sessionName, requesterSession);

  const commands: string[] = [];
  mockRunAppleRunnerCommand.mockImplementation(async (_device, command) => {
    commands.push(command.command);
    if (command.command === 'recordStart') {
      throw new Error('recording already in progress');
    }
    return {};
  });
  mockRunCmdBackground.mockImplementation(() => {
    throw new Error('runCmdBackground should not be used for iOS devices');
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './device.mp4'],
  });

  expect(response?.ok).toBe(false);
  expect((response as any).error?.code).toBe('COMMAND_FAILED');
  expect((response as any).error?.message ?? '').toMatch(
    /already in progress in session 'ios-device-owner'/,
  );
  expect(commands).toEqual(['recordStart']);
  expect(sessionStore.get(ownerSessionName)?.recording?.platform).toBe('ios-device-runner');
});

test('record stop clears iOS runner recording state when runner stop fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-stop-fail';
  sessionStore.set(sessionName, {
    ...makeIosDeviceSession(sessionName),
    recording: {
      platform: 'ios-device-runner',
      outPath: '/tmp/device.mp4',
      remotePath: 'tmp/device.mp4',
      startedAt: Date.now(),
      showTouches: false,
      gestureEvents: [],
    },
  });

  const runCmdCalls: Array<{ cmd: string; args: string[] }> = [];
  mockRunCmd.mockImplementation(async (cmd, args) => {
    runCmdCalls.push({ cmd, args });
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  mockRunAppleRunnerCommand.mockImplementation(async () => {
    throw new Error('runner disconnected');
  });
  mockRunCmdBackground.mockImplementation(() => {
    throw new Error('runCmdBackground should not be used for iOS devices');
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(true);
  expect((response as any).data?.recording).toBe('stopped');
  expect(runCmdCalls.length).toBe(1);
  expect(sessionStore.get(sessionName)?.recording).toBeUndefined();
});

test('record stop trims iOS device recordings from target app readiness before overlays', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device-trim';
  sessionStore.set(sessionName, {
    ...makeIosDeviceSession(sessionName, 'com.atebits.Tweetie2'),
    recording: {
      platform: 'ios-device-runner',
      outPath: '/tmp/device.mp4',
      remotePath: 'tmp/device.mp4',
      startedAt: Date.now(),
      runnerStartedAtUptimeMs: 10_000,
      targetAppReadyUptimeMs: 13_250,
      showTouches: true,
      gestureEvents: [{ kind: 'tap', tMs: 3_600, x: 50, y: 80 }],
    },
  });

  const lifecycleCalls: string[] = [];
  mockTrimRecordingStart.mockImplementation(async ({ videoPath, trimStartMs }) => {
    lifecycleCalls.push(`trim:${videoPath}:${trimStartMs}`);
  });
  mockOverlayRecordingTouches.mockImplementation(async ({ videoPath, telemetryPath }) => {
    lifecycleCalls.push(`overlay:${videoPath}:${telemetryPath}`);
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(true);
  const expectedLifecycleCalls = ['trim:/tmp/device.mp4:3250'];
  if (!overlaySupportWarning) {
    expectedLifecycleCalls.push(
      `overlay:/tmp/device.mp4:${deriveRecordingTelemetryPath('/tmp/device.mp4')}`,
    );
  }
  expect(lifecycleCalls).toEqual(expectedLifecycleCalls);
  expect((response as any).data?.overlayWarning).toBe(overlaySupportWarning);
});

test('record stop resizes iOS simulator recording when max-size is explicit', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-quality';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );

  mockRunCmdBackground.mockImplementation(() => ({
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  }));

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim-quality.mp4'],
    flags: { screenshotMaxSize: 720 },
  });

  const responseStop = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(responseStop?.ok).toBe(true);
  expect(mockResizeRecording).toHaveBeenCalledWith({
    videoPath: path.resolve('./sim-quality.mp4'),
    maxSize: 720,
    exportQuality: 'medium',
    targetLabel: 'iOS recording',
  });
});

test('record stop forwards the requested quality to the resize step', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-export-quality';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );

  mockRunCmdBackground.mockImplementation(() => ({
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  }));

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim-export-quality.mp4'],
    flags: { screenshotMaxSize: 720, quality: 'high' },
  });

  const responseStop = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(responseStop?.ok).toBe(true);
  expect(mockResizeRecording).toHaveBeenCalledWith({
    videoPath: path.resolve('./sim-export-quality.mp4'),
    maxSize: 720,
    exportQuality: 'high',
    targetLabel: 'iOS recording',
  });
});

test('record stop leaves a short visual tail after iOS simulator gestures', async () => {
  vi.useFakeTimers();
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-visual-tail';
  const kill = vi.fn();
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'Simulator',
    kind: 'simulator',
    booted: true,
  });
  session.recording = {
    platform: 'ios',
    outPath: '/tmp/visual-tail.mp4',
    startedAt: Date.now(),
    showTouches: true,
    gestureEvents: [{ kind: 'tap', tMs: 10, x: 20, y: 30 } as any],
    child: { kill },
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };
  sessionStore.set(sessionName, session);

  const responsePromise = runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  await vi.advanceTimersByTimeAsync(349);
  expect(kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  const response = await responsePromise;

  expect(response?.ok).toBe(true);
  expect(kill).toHaveBeenCalledWith('SIGINT');
});

test('record stop reports too-short iOS simulator recordings without leaving invalid output', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-too-short';
  const outPath = path.join(os.tmpdir(), `agent-device-too-short-${Date.now()}.mp4`);
  fs.writeFileSync(outPath, 'not-a-video');
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'Simulator',
    kind: 'simulator',
    booted: true,
  });
  session.recording = {
    platform: 'ios',
    outPath,
    startedAt: Date.now(),
    showTouches: false,
    gestureEvents: [],
    child: { kill: vi.fn() },
    wait: Promise.resolve({ stdout: '', stderr: 'failed to finalize', exitCode: 1 }),
  };
  sessionStore.set(sessionName, session);

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(false);
  expect((response as any).error?.message).toMatch(/wait at least 1000ms/i);
  expect((response as any).error?.message).toMatch(/failed to finalize/i);
  expect(fs.existsSync(outPath)).toBe(false);
});

test('record stop measures too-short iOS simulator recordings from stop request time', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-too-short-delayed-finalize';
  const outPath = path.join(os.tmpdir(), `agent-device-too-short-delayed-${Date.now()}.mp4`);
  fs.writeFileSync(outPath, 'not-a-video');
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'Simulator',
    kind: 'simulator',
    booted: true,
  });
  session.recording = {
    platform: 'ios',
    outPath,
    startedAt: Date.now() - 500,
    showTouches: false,
    gestureEvents: [],
    child: { kill: vi.fn() },
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };
  sessionStore.set(sessionName, session);
  mockWaitForStableFile.mockImplementation(async () => {
    vi.setSystemTime(11_300);
  });
  mockIsPlayableVideo.mockImplementation(async () => false);

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(false);
  expect((response as any).error?.message).toMatch(/Recording stopped after 500ms/i);
  expect((response as any).error?.message).toMatch(/wait at least 1000ms/i);
  expect(fs.existsSync(outPath)).toBe(false);
});

test('record stop measures too-short Android failures from stop request time', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(20_000);
  const sessionStore = makeSessionStore();
  const sessionName = 'android-too-short-delayed-stop';
  const session = makeSession(sessionName, {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Android',
    kind: 'device',
    booted: true,
  });
  session.recording = {
    platform: 'android',
    outPath: path.resolve('./android-too-short.mp4'),
    startedAt: Date.now() - 500,
    showTouches: true,
    gestureEvents: [],
    remotePath: '/sdcard/agent-device-recording-too-short.mp4',
    remotePid: '4322',
    chunks: [
      {
        index: 1,
        path: path.resolve('./android-too-short.mp4'),
        remotePath: '/sdcard/agent-device-recording-too-short.mp4',
      },
    ],
  };
  sessionStore.set(sessionName, session);
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    if (command === '-s emulator-5554 shell ps -o pid= -p 4322') {
      return { stdout: '4322\n', stderr: '', exitCode: 0 };
    }
    if (command === '-s emulator-5554 shell kill -2 4322') {
      vi.setSystemTime(21_300);
      return { stdout: '', stderr: 'failed to stop', exitCode: 1 };
    }
    if (command === '-s emulator-5554 shell kill -9 4322') {
      return { stdout: '', stderr: 'failed to force stop', exitCode: 1 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(false);
  expect((response as any).error?.message).toMatch(/Recording stopped after 500ms/i);
  expect((response as any).error?.message).toMatch(/wait at least 1000ms/i);
  expect((response as any).error?.message).toMatch(/failed to stop/i);
});

test('record start stores iOS simulator recorder pid for scoped cleanup', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-recorder-pid';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );
  mockRunCmdBackground.mockImplementation(() => ({
    child: { kill: () => {}, pid: 5151 } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  }));

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim-recorder-pid.mp4'],
    flags: { hideTouches: true },
  });

  expect(response?.ok).toBe(true);
  const recording = sessionStore.get(sessionName)?.recording;
  expect(recording?.platform).toBe('ios');
  if (recording?.platform === 'ios') {
    expect(recording.recorderPid).toBe(5151);
  }
});

test('record stop prefers session-owned iOS recorder processes before path fallback', async () => {
  vi.useFakeTimers();
  const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-owned-recorder';
  const kill = vi.fn();
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'Simulator',
    kind: 'simulator',
    booted: true,
  });
  session.recording = {
    platform: 'ios',
    outPath: '/tmp/owned-recorder.mp4',
    startedAt: Date.now(),
    showTouches: true,
    gestureEvents: [],
    recorderPid: 1111,
    child: { kill, pid: 1111 },
    wait: new Promise(() => {}),
  };
  sessionStore.set(sessionName, session);
  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'pgrep' && args[0] === '-P') {
      expect(args).toEqual(['-P', '1111']);
      return { stdout: '2222\n', stderr: '', exitCode: 0 };
    }
    if (cmd === 'pgrep' && args[0] === '-f') {
      throw new Error('path fallback should not run when owned recorder cleanup matches');
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  try {
    const responsePromise = runRecordCommand({
      sessionStore,
      sessionName,
      positionals: ['stop'],
    });

    await vi.advanceTimersByTimeAsync(12_000);
    const response = await responsePromise;

    expect(response?.ok).toBe(false);
    expect((response as any).error?.message).toMatch(/did not exit/);
    expect(kill.mock.calls.map((call) => call[0])).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(mockRunCmd.mock.calls.map((call) => call[1])).toEqual([
      ['-P', '1111'],
      ['-P', '1111'],
      ['-P', '1111'],
    ]);
    expect(processKill.mock.calls.map((call) => call[0])).toEqual([
      1111, 2222, 1111, 2222, 1111, 2222,
    ]);
    expect(processKill.mock.calls.map((call) => call[1])).toEqual([
      'SIGINT',
      'SIGINT',
      'SIGTERM',
      'SIGTERM',
      'SIGKILL',
      'SIGKILL',
    ]);
  } finally {
    processKill.mockRestore();
  }
});

test('record stop falls back to path matching for stale iOS simulator recordVideo processes', async () => {
  vi.useFakeTimers();
  const processKill = vi.spyOn(process, 'kill').mockImplementation(() => true);
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-stale-recorder';
  const kill = vi.fn();
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'Simulator',
    kind: 'simulator',
    booted: true,
  });
  session.recording = {
    platform: 'ios',
    outPath: '/tmp/stale-recorder.mp4',
    startedAt: Date.now(),
    showTouches: true,
    gestureEvents: [],
    child: { kill },
    wait: new Promise(() => {}),
  };
  sessionStore.set(sessionName, session);
  mockRunCmd.mockImplementation(async (cmd, args) => {
    if (cmd === 'pgrep') {
      expect(args).toEqual(['-f', 'simctl.*recordVideo.*/tmp/stale-recorder\\.mp4']);
      return { stdout: '4242\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  try {
    const responsePromise = runRecordCommand({
      sessionStore,
      sessionName,
      positionals: ['stop'],
    });

    await vi.advanceTimersByTimeAsync(12_000);
    const response = await responsePromise;

    expect(response?.ok).toBe(false);
    expect((response as any).error?.message).toMatch(/did not exit/);
    expect(kill.mock.calls.map((call) => call[0])).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
    expect(processKill.mock.calls.map((call) => call[1])).toEqual(['SIGINT', 'SIGTERM', 'SIGKILL']);
  } finally {
    processKill.mockRestore();
  }
});

test('record stop keeps iOS simulator video when overlay export fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-overlay-warning';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );

  mockRunCmdBackground.mockImplementation(() => ({
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  }));
  mockOverlayRecordingTouches.mockImplementation(async () => {
    throw new Error('swift export failed');
  });

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim-warning.mp4'],
  });
  sessionStore.get(sessionName)?.recording?.gestureEvents.push({
    kind: 'tap',
    tMs: 120,
    x: 90,
    y: 180,
  });

  const responseStop = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(responseStop?.ok).toBe(true);
  expect((responseStop as any).data?.overlayWarning).toBe(
    overlaySupportWarning ?? 'failed to overlay recording touches: swift export failed',
  );
});

test('record stop skips touch overlay export when no gestures were recorded', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-no-gestures';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );

  mockRunCmdBackground.mockImplementation(() => ({
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  }));

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim-no-gestures.mp4'],
  });

  const responseStop = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(responseStop?.ok).toBe(true);
  expect(mockOverlayRecordingTouches).not.toHaveBeenCalled();
  expect((responseStop as any).data?.overlayWarning).toBeUndefined();
});

test('record stop keeps iOS simulator video when resize export fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-resize-fail';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );

  mockRunCmdBackground.mockImplementation(() => ({
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  }));

  mockResizeRecording.mockImplementation(async () => {
    throw new Error('resize failed');
  });

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim-resize-fail.mp4'],
    flags: { screenshotMaxSize: 720 },
  });

  const responseStop = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(responseStop?.ok).toBe(true);
  expect((responseStop as any).data?.overlayWarning ?? '').toMatch(/failed to resize recording/i);
});

test('record start does not fail when iOS simulator runner warm-up fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-warm-failure';
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'Simulator',
    kind: 'simulator',
    booted: true,
  });
  session.appBundleId = 'com.apple.Preferences';
  sessionStore.set(sessionName, session);

  let started = false;
  mockRunCmdBackground.mockImplementation(() => {
    started = true;
    return {
      child: { kill: () => {} } as any,
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    };
  });
  const runnerCalls: RunnerCall[] = [];
  mockRunAppleRunnerCommand.mockImplementation(async (_device, command) => {
    runnerCalls.push({ command: command.command });
    if (command.command === 'snapshot') {
      throw new Error('runner warm-up unavailable');
    }
    return { currentUptimeMs: 30_000 };
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim.mp4'],
  });

  expect(response?.ok).toBe(true);
  expect(started).toBe(true);
  // Warm-up failure falls back to the standalone uptime command for the anchor.
  expect(runnerCalls.map((call) => call.command)).toEqual(['snapshot', 'uptime']);
  const recording = sessionStore.get(sessionName)?.recording;
  expect(recording?.platform).toBe('ios');
  if (recording?.platform === 'ios') {
    expect(recording.gestureClockOriginUptimeMs).toBe(30_000);
  }
});

test('record start anchors gesture clock from simulator warm-up and skips standalone uptime', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-warm-anchor';
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'Simulator',
    kind: 'simulator',
    booted: true,
  });
  session.appBundleId = 'com.apple.Preferences';
  sessionStore.set(sessionName, session);

  mockRunCmdBackground.mockImplementation(() => ({
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  }));
  const runnerCalls: RunnerCall[] = [];
  mockRunAppleRunnerCommand.mockImplementation(async (_device, command) => {
    runnerCalls.push({ command: command.command });
    if (command.command === 'snapshot') {
      return { currentUptimeMs: 20_000 };
    }
    return {};
  });

  const beforeMs = Date.now();
  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim-warm-anchor.mp4'],
  });
  const afterMs = Date.now();

  expect(response?.ok).toBe(true);
  expect(runnerCalls.map((call) => call.command)).toEqual(['snapshot']);
  const recording = sessionStore.get(sessionName)?.recording;
  expect(recording?.platform).toBe('ios');
  if (recording?.platform === 'ios') {
    expect(recording.gestureClockOriginUptimeMs).toBe(20_000);
    expect(recording.gestureClockOriginAtMs).toBeGreaterThanOrEqual(beforeMs);
    expect(recording.gestureClockOriginAtMs).toBeLessThanOrEqual(afterMs);
  }
});

test('record start falls back to standalone uptime when warm response lacks currentUptimeMs', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-warm-missing';
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'Simulator',
    kind: 'simulator',
    booted: true,
  });
  session.appBundleId = 'com.apple.Preferences';
  sessionStore.set(sessionName, session);

  mockRunCmdBackground.mockImplementation(() => ({
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  }));
  const runnerCalls: RunnerCall[] = [];
  mockRunAppleRunnerCommand.mockImplementation(async (_device, command) => {
    runnerCalls.push({ command: command.command });
    if (command.command === 'uptime') {
      return { currentUptimeMs: 30_000 };
    }
    return {};
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim-warm-missing.mp4'],
  });

  expect(response?.ok).toBe(true);
  expect(runnerCalls.map((call) => call.command)).toEqual(['snapshot', 'uptime']);
  const recording = sessionStore.get(sessionName)?.recording;
  expect(recording?.platform).toBe('ios');
  if (recording?.platform === 'ios') {
    expect(recording.gestureClockOriginUptimeMs).toBe(30_000);
  }
});

test('record start rejects non-finite or non-positive warm anchors', async () => {
  for (const badValue of [Number.NaN, -1]) {
    const sessionStore = makeSessionStore();
    const sessionName = `ios-sim-warm-bad-${badValue}`;
    const session = makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'Simulator',
      kind: 'simulator',
      booted: true,
    });
    session.appBundleId = 'com.apple.Preferences';
    sessionStore.set(sessionName, session);

    mockRunCmdBackground.mockImplementation(() => ({
      child: { kill: () => {} } as any,
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    }));
    const runnerCalls: RunnerCall[] = [];
    mockRunAppleRunnerCommand.mockImplementation(async (_device, command) => {
      runnerCalls.push({ command: command.command });
      if (command.command === 'snapshot') {
        return { currentUptimeMs: badValue };
      }
      return { currentUptimeMs: 30_000 };
    });

    const response = await runRecordCommand({
      sessionStore,
      sessionName,
      positionals: ['start', `./sim-warm-bad-${badValue}.mp4`],
    });

    expect(response?.ok).toBe(true);
    expect(runnerCalls.map((call) => call.command)).toEqual(['snapshot', 'uptime']);
    const recording = sessionStore.get(sessionName)?.recording;
    expect(recording?.platform).toBe('ios');
    if (recording?.platform === 'ios') {
      expect(recording.gestureClockOriginUptimeMs).toBe(30_000);
    }
  }
});

test('record start degrades to wall-clock when warm anchor missing and uptime fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-anchor-degraded';
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'Simulator',
    kind: 'simulator',
    booted: true,
  });
  session.appBundleId = 'com.apple.Preferences';
  sessionStore.set(sessionName, session);

  mockRunCmdBackground.mockImplementation(() => ({
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  }));
  mockRunAppleRunnerCommand.mockImplementation(async (_device, command) => {
    if (command.command === 'uptime') {
      throw new Error('uptime unavailable');
    }
    return {};
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim-anchor-degraded.mp4'],
  });

  expect(response?.ok).toBe(true);
  const recording = sessionStore.get(sessionName)?.recording;
  expect(recording?.platform).toBe('ios');
  if (recording?.platform === 'ios') {
    expect(recording.gestureClockOriginAtMs).toBeUndefined();
    expect(recording.gestureClockOriginUptimeMs).toBeUndefined();
  }
});

test('record start skips iOS simulator runner warm-up when touch overlays are hidden', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-hide-touches';
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'Simulator',
    kind: 'simulator',
    booted: true,
  });
  session.appBundleId = 'com.apple.Preferences';
  sessionStore.set(sessionName, session);

  mockRunCmdBackground.mockImplementation(() => ({
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  }));

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './sim-hide-touches.mp4'],
    flags: { hideTouches: true },
  });

  expect(response?.ok).toBe(true);
  expect(mockRunAppleRunnerCommand).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)?.recording?.showTouches).toBe(false);
});

test('record start/stop overlays Android gestures by default on devices', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-overlay';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Android',
      kind: 'device',
      booted: true,
    }),
  );

  const adbCalls: Array<string[]> = [];
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    adbCalls.push(args);
    if (
      /^-s emulator-5554 shell screenrecord --bit-rate 8000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
        args.join(' '),
      )
    ) {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(
        args.join(' '),
      )
    ) {
      return { stdout: '1024\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './android.mp4'],
  });
  const startedRecording = sessionStore.get(sessionName)?.recording;
  expect(startedRecording?.platform).toBe('android');
  startedRecording?.gestureEvents.push({ kind: 'tap', tMs: 120, x: 90, y: 180 });

  const overlayCalls: Array<{ videoPath: string; telemetryPath: string }> = [];
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    adbCalls.push(args);
    if (args.join(' ') === '-s emulator-5554 shell ps -o pid= -p 4321') {
      return { stdout: '', stderr: '', exitCode: 1 };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(
        args.join(' '),
      )
    ) {
      return { stdout: '2048\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  mockOverlayRecordingTouches.mockImplementation(async ({ videoPath, telemetryPath }) => {
    overlayCalls.push({ videoPath, telemetryPath });
  });

  const responseStop = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(adbCalls.some((args) => args.join(' ') === '-s emulator-5554 shell kill -2 4321')).toBe(
    true,
  );
  expect(responseStop?.ok).toBe(true);
  if (!responseStop?.ok) {
    throw new Error('expected successful Android record stop response');
  }
  if (overlaySupportWarning) {
    expect(overlayCalls).toEqual([]);
    expect(responseStop.data?.overlayWarning).toBe(overlaySupportWarning);
  } else {
    expect(overlayCalls).toEqual([
      {
        videoPath: path.resolve('./android.mp4'),
        telemetryPath: deriveRecordingTelemetryPath(path.resolve('./android.mp4')),
      },
    ]);
    expect(responseStop.data?.overlayWarning).toBeUndefined();
  }
});

test('record start rejects Android max-size when wm size is unparseable', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-quality-unparseable';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Android',
      kind: 'device',
      booted: true,
    }),
  );

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    if (command === '-s emulator-5554 shell wm size') {
      return { stdout: 'w=oops\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './android.mp4'],
    flags: { screenshotMaxSize: 720, quality: 'high' },
  });

  expect(response?.ok).toBe(false);
  expect((response as any).error?.code).toBe('COMMAND_FAILED');
});

test('record stop keeps Android video when overlay export fails', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-overlay-warning';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Android',
      kind: 'device',
      booted: true,
    }),
  );

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    if (
      /^-s emulator-5554 shell screenrecord --bit-rate 8000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
        command,
      )
    ) {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)
    ) {
      return { stdout: '1024\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './android-warning.mp4'],
  });

  const startedRecording = sessionStore.get(sessionName)?.recording;
  startedRecording?.gestureEvents.push({ kind: 'tap', tMs: 120, x: 90, y: 180 });

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    if (command === '-s emulator-5554 shell ps -o pid= -p 4321') {
      return { stdout: '', stderr: '', exitCode: 1 };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)
    ) {
      return { stdout: '2048\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });
  mockOverlayRecordingTouches.mockImplementation(async () => {
    throw new Error('android overlay export failed');
  });

  const responseStop = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(responseStop?.ok).toBe(true);
  expect((responseStop as any).data?.overlayWarning).toBe(
    overlaySupportWarning ?? 'failed to overlay recording touches: android overlay export failed',
  );
});

test('record stop force-kills Android screenrecord when SIGINT fails but process is still running', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-force-stop';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Android',
      kind: 'device',
      booted: true,
    }),
  );

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    if (
      /^-s emulator-5554 shell screenrecord --bit-rate 8000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
        command,
      )
    ) {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)
    ) {
      return { stdout: '1024\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './android.mp4'],
  });

  const adbCalls: string[] = [];
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    adbCalls.push(command);
    if (command === '-s emulator-5554 shell kill -2 4321') {
      return { stdout: '', stderr: 'operation not permitted', exitCode: 1 };
    }
    if (command === '-s emulator-5554 shell ps -o pid= -p 4321') {
      return {
        stdout: adbCalls.includes('-s emulator-5554 shell kill -9 4321') ? '' : '4321\n',
        stderr: '',
        exitCode: 0,
      };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)
    ) {
      return { stdout: '2048\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(true);
  expect(adbCalls.includes('-s emulator-5554 shell kill -2 4321')).toBe(true);
  expect(adbCalls.includes('-s emulator-5554 shell kill -9 4321')).toBe(true);
  expect(
    adbCalls.some((command) =>
      /^-s emulator-5554 shell rm -f \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command),
    ),
  ).toBe(true);
});

test('record stop warns when Android screenrecord hit the 180s platform limit', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-screenrecord-limit';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Android',
      kind: 'device',
      booted: true,
    }),
  );

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    if (
      /^-s emulator-5554 shell screenrecord --bit-rate 8000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
        command,
      )
    ) {
      return { stdout: '4321\n', stderr: '', exitCode: 0 };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)
    ) {
      return { stdout: '1024\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './android-limit.mp4'],
  });

  const recording = sessionStore.get(sessionName)?.recording;
  if (recording) {
    recording.startedAt = Date.now() - 181_000;
  }

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    if (command === '-s emulator-5554 shell ps -o pid= -p 4321') {
      return { stdout: '', stderr: '', exitCode: 1 };
    }
    if (command === '-s emulator-5554 shell kill -2 4321') {
      return { stdout: '', stderr: 'No such process', exitCode: 1 };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)
    ) {
      return { stdout: '2048\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(true);
  expect((response as any).data?.warning).toMatch(/180s platform limit/);
});

test('record stop returns multiple Android recording chunks', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-screenrecord-chunks';
  const session = makeSession(sessionName, {
    platform: 'android',
    id: 'emulator-5554',
    name: 'Android',
    kind: 'device',
    booted: true,
  });
  session.recording = {
    platform: 'android',
    outPath: path.resolve('./android-long.mp4'),
    startedAt: Date.now() - 172_000,
    showTouches: true,
    gestureEvents: [{ kind: 'tap', tMs: 120, x: 90, y: 180 }],
    remotePath: '/sdcard/agent-device-recording-2.mp4',
    remotePid: '4322',
    warning:
      'Android adb screenrecord is capped at 180s, so this recording was split into multiple MP4 chunks.',
    chunks: [
      {
        index: 1,
        path: path.resolve('./android-long.mp4'),
        remotePath: '/sdcard/agent-device-recording-1.mp4',
      },
      {
        index: 2,
        path: path.resolve('./android-long.part-002.mp4'),
        remotePath: '/sdcard/agent-device-recording-2.mp4',
      },
    ],
  };
  sessionStore.set(sessionName, session);

  const adbCommands: string[] = [];
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    adbCommands.push(command);
    if (command === '-s emulator-5554 shell ps -o pid= -p 4322') {
      return adbCommands.includes('-s emulator-5554 shell kill -2 4322')
        ? { stdout: '', stderr: '', exitCode: 1 }
        : { stdout: '4322\n', stderr: '', exitCode: 0 };
    }
    if (command === '-s emulator-5554 shell kill -2 4322') {
      return { stdout: '', stderr: '', exitCode: 0 };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)
    ) {
      return { stdout: '2048\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(true);
  if (response?.ok !== true) {
    throw new Error('expected successful Android record stop response');
  }
  expect(response.data?.warning).toMatch(/split into multiple MP4 chunks/);
  expect(response.data?.overlayWarning).toMatch(/skipped for chunked Android recordings/);
  expect(response.data?.chunks).toEqual([
    expect.objectContaining({ index: 1, path: path.resolve('./android-long.mp4') }),
    expect.objectContaining({ index: 2, path: path.resolve('./android-long.part-002.mp4') }),
  ]);
  expect(response.data?.artifacts).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field: 'outPath', path: path.resolve('./android-long.mp4') }),
      expect.objectContaining({
        field: 'chunkPath',
        path: path.resolve('./android-long.part-002.mp4'),
      }),
    ]),
  );
  expect(adbCommands).toEqual(
    expect.arrayContaining([
      '-s emulator-5554 pull /sdcard/agent-device-recording-1.mp4 ' +
        path.resolve('./android-long.mp4'),
      '-s emulator-5554 pull /sdcard/agent-device-recording-2.mp4 ' +
        path.resolve('./android-long.part-002.mp4'),
    ]),
  );
});

test('record stop keeps iOS simulator video when touch overlay recording was invalidated', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-invalidated-recording';
  const session = makeSession(sessionName, {
    platform: 'apple',
    id: 'sim-1',
    name: 'iPhone 17 Pro',
    kind: 'simulator',
    booted: true,
  });
  session.recording = {
    platform: 'ios',
    outPath: path.resolve('./invalidated.mp4'),
    startedAt: Date.now() - 1_000,
    showTouches: true,
    gestureEvents: [],
    invalidatedReason: 'iOS runner session exited during recording',
    child: { kill: () => {} } as any,
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };
  sessionStore.set(sessionName, session);

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['stop'],
  });

  expect(response?.ok).toBe(true);
  if (response?.ok === true) {
    expect(response.data?.outPath).toBe(path.resolve('./invalidated.mp4'));
    expect(response.data?.overlayWarning).toBe(
      'overlay unavailable: iOS runner session exited during recording',
    );
  }
  expect(sessionStore.get(sessionName)?.recording).toBeUndefined();
});

test('record start accepts Android screenrecord before the remote file begins growing', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-running-without-file-growth';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Android',
      kind: 'device',
      booted: true,
    }),
  );

  let psChecks = 0;
  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    if (
      /^-s emulator-5554 shell screenrecord --bit-rate 8000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
        command,
      )
    ) {
      return { stdout: '5555\n', stderr: '', exitCode: 0 };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/sdcard\/agent-device-recording-\d+\.mp4$/.test(command)
    ) {
      return { stdout: '0\n', stderr: '', exitCode: 0 };
    }
    if (command === '-s emulator-5554 shell ps -o pid= -p 5555') {
      psChecks += 1;
      return { stdout: '5555\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './android.mp4'],
  });

  expect(response?.ok).toBe(true);
  expect(psChecks >= 2).toBe(true);
});

test('record start falls back to /data/local/tmp when /sdcard is unavailable on Android', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-fallback-path';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'android',
      id: 'emulator-5554',
      name: 'Android',
      kind: 'device',
      booted: true,
    }),
  );

  mockRunCmd.mockImplementation(async (_cmd, args) => {
    const command = args.join(' ');
    if (
      /^-s emulator-5554 shell screenrecord --bit-rate 8000000 \/sdcard\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
        command,
      )
    ) {
      return { stdout: 'permission denied\n', stderr: '', exitCode: 1 };
    }
    if (
      /^-s emulator-5554 shell screenrecord --bit-rate 8000000 \/data\/local\/tmp\/agent-device-recording-\d+\.mp4 >\/dev\/null 2>&1 & echo \$!$/.test(
        command,
      )
    ) {
      return { stdout: '7777\n', stderr: '', exitCode: 0 };
    }
    if (
      /^-s emulator-5554 shell stat -c %s \/data\/local\/tmp\/agent-device-recording-\d+\.mp4$/.test(
        command,
      )
    ) {
      return { stdout: '1024\n', stderr: '', exitCode: 0 };
    }
    return { stdout: '', stderr: '', exitCode: 0 };
  });

  const response = await runRecordCommand({
    sessionStore,
    sessionName,
    positionals: ['start', './android.mp4'],
  });

  expect(response?.ok).toBe(true);
  const recording = sessionStore.get(sessionName)?.recording;
  expect(recording?.platform).toBe('android');
  expect(recording?.platform === 'android' ? recording.remotePath : '').toMatch(
    /^\/data\/local\/tmp\/agent-device-recording-\d+\.mp4$/,
  );
});
