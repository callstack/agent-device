import { test, expect, vi, beforeEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';

vi.mock('../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../core/dispatch.ts')>();
  return { ...actual, dispatchCommand: vi.fn(async () => ({})) };
});

vi.mock('../../platforms/apple/core/runner/runner-client.ts', () => ({
  getRunnerSessionSnapshot: vi.fn(),
}));

import { dispatchCommand } from '../../core/dispatch.ts';
import { getRunnerSessionSnapshot } from '../../platforms/apple/core/runner/runner-client.ts';
import { createRequestHandler } from '../request-router.ts';
import type { SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockGetRunnerSessionSnapshot = vi.mocked(getRunnerSessionSnapshot);

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockGetRunnerSessionSnapshot.mockReset();
});

test('router blocks non-record commands when recording was invalidated', async () => {
  const sessionStore = makeSessionStore('agent-device-router-recording-health-');
  const session: SessionState = {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.apple.Preferences',
    device: {
      platform: 'apple',
      target: 'mobile',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    },
    recording: {
      platform: 'ios',
      outPath: '/tmp/demo.mp4',
      startedAt: Date.now() - 1_000,
      showTouches: true,
      gestureEvents: [],
      invalidatedReason: 'iOS runner session restarted during recording',
      child: { kill: () => {} } as any,
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  };
  sessionStore.set('default', session);

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'scroll',
    positionals: ['down'],
    meta: { requestId: 'req-invalidated-recording' },
  });

  expect(response.ok).toBe(false);
  if (response.ok) {
    return;
  }
  expect(response.error.code).toBe('COMMAND_FAILED');
  expect(response.error.message).toBe('iOS runner session restarted during recording');
  expect(mockDispatch).not.toHaveBeenCalled();
});

test('router allows iOS simulator gestures during overlay recording after runner restart', async () => {
  const sessionStore = makeSessionStore('agent-device-router-recording-health-');
  const session: SessionState = {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.apple.Preferences',
    device: {
      platform: 'apple',
      target: 'mobile',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    },
    recording: {
      platform: 'ios',
      outPath: '/tmp/demo.mp4',
      startedAt: Date.now() - 1_000,
      showTouches: true,
      gestureEvents: [],
      runnerSessionId: 'runner-before',
      child: { kill: () => {} } as any,
      wait: Promise.resolve({ stdout: '', stderr: '', exitCode: 0 }),
    },
  };
  sessionStore.set('default', session);
  mockGetRunnerSessionSnapshot.mockReturnValue({
    alive: true,
    sessionId: 'runner-after',
  });
  mockDispatch.mockResolvedValue({
    action: 'pinch',
    scale: 1.2,
    x: 100,
    y: 200,
    durationMs: 280,
  });

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    trackDownloadableArtifact: () => 'artifact-id',
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'pinch',
    positionals: ['1.2', '100', '200'],
    meta: { requestId: 'req-simulator-runner-restart' },
  });

  expect(response.ok).toBe(true);
  expect(mockGetRunnerSessionSnapshot).not.toHaveBeenCalled();
  expect(mockDispatch).toHaveBeenCalled();
  const recording = sessionStore.get('default')?.recording;
  expect(recording?.invalidatedReason).toBeUndefined();
  expect(recording?.gestureEvents).toHaveLength(1);
  expect(recording?.gestureEvents[0]?.kind).toBe('pinch');
});
