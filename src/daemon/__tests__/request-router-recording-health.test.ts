import { createTestDeviceInventoryGateways } from '../../__tests__/test-utils/device-inventory-gateways.ts';
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
import {
  createRequestHandler,
  gestureDeviceRuntimeGateway,
  gestureRuntimeSpies,
} from './test-device-runtime-gateway.ts';
import type { SessionState } from '../types.ts';
import { LeaseRegistry } from '../lease-registry.ts';
import { makeSessionStore } from '../../__tests__/test-utils/store-factory.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/test-utils/screen-recording-live-handle.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockGetRunnerSessionSnapshot = vi.mocked(getRunnerSessionSnapshot);

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  for (const spy of Object.values(gestureRuntimeSpies)) spy.mockClear();
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
      appleOs: 'ios',
      target: 'mobile',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    },
  };
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'runner AVAssetWriter',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    invalidatedReason: 'iOS runner session restarted during recording',
  });
  sessionStore.set('default', session);

  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
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

test('router allows canonical iOS simulator gestures during overlay recording after runner restart', async () => {
  const sessionStore = makeSessionStore('agent-device-router-recording-health-');
  const session: SessionState = {
    name: 'default',
    createdAt: Date.now(),
    actions: [],
    appBundleId: 'com.apple.Preferences',
    device: {
      platform: 'apple',
      appleOs: 'ios',
      target: 'mobile',
      id: 'sim-1',
      name: 'iPhone 17 Pro',
      kind: 'simulator',
      booted: true,
    },
  };
  session.screenRecording = makeTestScreenRecordingResource(session, {
    backend: 'simctl recordVideo',
    outPath: '/tmp/demo.mp4',
    startedAt: Date.now() - 1_000,
    runnerSessionId: 'runner-before',
  });
  sessionStore.set('default', session);
  mockGetRunnerSessionSnapshot.mockReturnValue({
    alive: true,
    sessionId: 'runner-after',
  });
  const handler = createRequestHandler({
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    deviceRuntimeGateway: gestureDeviceRuntimeGateway,
  });

  const response = await handler({
    token: 'test-token',
    session: 'default',
    command: 'gesture',
    positionals: [],
    input: { kind: 'pinch', scale: 1.2, origin: { x: 100, y: 200 } },
    meta: { requestId: 'req-simulator-runner-restart' },
  });

  expect(response.ok).toBe(true);
  expect(mockGetRunnerSessionSnapshot).not.toHaveBeenCalled();
  expect(gestureRuntimeSpies.gestureViewport).toHaveBeenCalledOnce();
  expect(gestureRuntimeSpies.performMultiTouchGesturePlan).toHaveBeenCalledOnce();
  const recording = sessionStore.get('default')?.screenRecording?.handle.inspect();
  expect(recording?.invalidatedReason).toBeUndefined();
  expect(recording?.gestureEvents).toHaveLength(1);
  expect(recording?.gestureEvents[0]?.kind).toBe('pinch');
});
