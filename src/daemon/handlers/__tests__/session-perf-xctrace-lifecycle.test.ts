import assert from 'node:assert/strict';
import { beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';
import { makeIosSession } from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import type { AppleXctracePerfCapture } from '../../../platforms/apple/core/perf-xctrace.ts';

const applePerfMocks = vi.hoisted(() => ({
  startAppleXctracePerfCapture: vi.fn(),
  stopAppleXctracePerfCapture: vi.fn(),
}));

vi.mock('../../../platforms/apple/core/perf-xctrace.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platforms/apple/core/perf-xctrace.ts')>();
  return {
    ...actual,
    startAppleXctracePerfCapture: applePerfMocks.startAppleXctracePerfCapture,
    stopAppleXctracePerfCapture: applePerfMocks.stopAppleXctracePerfCapture,
  };
});

import { handleSessionObservabilityCommands } from '../session-observability.ts';

beforeEach(() => {
  vi.resetAllMocks();
});

test('perf cpu profile xctrace start and stop manage compact artifact lifecycle', async () => {
  const sessionStore = makeSessionStore('agent-device-session-observability-perf-');
  sessionStore.set('ios', makeIosSession('ios', { appBundleId: 'com.example.app' }));
  const activeCapture = makeCapture('cpu-profile', '/tmp/app.trace');
  applePerfMocks.startAppleXctracePerfCapture.mockResolvedValue(activeCapture);
  applePerfMocks.stopAppleXctracePerfCapture.mockResolvedValue({
    ...activeCapture,
    endedAt: '2026-04-01T10:00:05.000Z',
  });

  const startResponse = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'perf',
      positionals: ['cpu', 'profile', 'start', 'xctrace', 'Time Profiler', '/tmp/app.trace'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });
  assert.equal(startResponse?.ok, true);
  assert.equal(startResponse?.data?.perf, 'started');
  assert.equal(sessionStore.get('ios')?.applePerf?.active?.outPath, '/tmp/app.trace');

  const stopResponse = await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'perf',
      positionals: ['cpu', 'profile', 'stop', 'xctrace', '', '/tmp/app.trace'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });
  assert.equal(stopResponse?.ok, true);
  assert.equal(sessionStore.get('ios')?.applePerf?.active, undefined);
  assert.equal(sessionStore.get('ios')?.applePerf?.lastProfileTracePath, '/tmp/app.trace');
});

test('perf xctrace stop clears active capture when cleanup is confirmed', async () => {
  const sessionStore = makeStoreWithCapture(makeCapture('trace', '/tmp/hitches.trace'));
  applePerfMocks.stopAppleXctracePerfCapture.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'Hitches is not supported on this platform.', {
      captureCleanedUp: true,
    }),
  );

  const response = await stopTrace(sessionStore);
  assert.equal(response?.ok, false);
  assert.equal(sessionStore.get('ios')?.applePerf?.active, undefined);
});

test('perf xctrace stop keeps active capture when cleanup is not confirmed', async () => {
  const sessionStore = makeStoreWithCapture(makeCapture('trace', '/tmp/hitches.trace'));
  applePerfMocks.stopAppleXctracePerfCapture.mockRejectedValue(
    new AppError('COMMAND_FAILED', 'Timed out waiting for Apple xctrace capture to stop', {
      captureCleanedUp: false,
    }),
  );

  const response = await stopTrace(sessionStore);
  assert.equal(response?.ok, false);
  assert.equal(sessionStore.get('ios')?.applePerf?.active?.outPath, '/tmp/hitches.trace');
});

function makeCapture(
  mode: AppleXctracePerfCapture['mode'],
  outPath: string,
): AppleXctracePerfCapture {
  return {
    kind: 'xctrace',
    mode,
    template: mode === 'cpu-profile' ? 'Time Profiler' : 'Animation Hitches',
    outPath,
    appBundleId: 'com.example.app',
    deviceId: 'ios-sim',
    platform: 'ios',
    targetPids: [111],
    targetProcesses: ['Example'],
    startedAt: '2026-04-01T10:00:00.000Z',
    child: {
      kill: vi.fn(() => true),
      pid: 1234,
    } as unknown as AppleXctracePerfCapture['child'],
    wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
  };
}

function makeStoreWithCapture(capture: AppleXctracePerfCapture) {
  const sessionStore = makeSessionStore('agent-device-session-observability-perf-');
  sessionStore.set(
    'ios',
    makeIosSession('ios', {
      appBundleId: 'com.example.app',
      applePerf: { active: capture },
    }),
  );
  return sessionStore;
}

async function stopTrace(sessionStore: ReturnType<typeof makeSessionStore>) {
  return await handleSessionObservabilityCommands({
    req: {
      token: 't',
      session: 'ios',
      command: 'perf',
      positionals: ['trace', 'stop', 'xctrace', '', '/tmp/hitches.trace'],
      flags: {},
    },
    sessionName: 'ios',
    sessionStore,
  });
}
