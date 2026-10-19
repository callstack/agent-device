import { createTestDeviceInventoryGateways } from '@agent-device/device-selection/inventory-gateways-fixtures';
import { legacyDispatchCapture } from '../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { test, expect, vi, beforeEach } from 'vitest';
import { buildGesturePlan } from '@agent-device/contracts/gesture-plan';
import type { GestureSemanticInput } from '@agent-device/contracts/gesture-plan-types';
import type { DaemonGestureResult } from '@agent-device/contracts/daemon-command-surface';

import path from 'node:path';
import { createTouchCommandSurface } from '../../__tests__/support/touch-command-surface-fake.ts';
const testCreateCommandSurface = createTouchCommandSurface({
  members: (config) => ({
    interactions: {
      gesture: async ({ gesture, session, requestId, signal }) => {
        if (!('intent' in gesture) || gesture.intent !== 'pinch') {
          throw new Error('recording-health fixture expects a pinch gesture');
        }
        const context = { session, requestId, signal: signal ?? config.signal };
        const viewport = await config.backend.resolveGestureViewport?.(context);
        if (!viewport) throw new Error('gesture runtime did not provide a viewport');
        const plan = buildGesturePlan(gesture as GestureSemanticInput, viewport, 'ios');
        const backendResult = await config.backend.performGesture?.(context, plan);
        const first = plan.pointers[0].samples[0]?.point;
        const last = plan.pointers[0].samples.at(-1)?.point;
        if (!first || !last) throw new Error('pinch plan has no pointer samples');
        return {
          kind: plan.intent,
          durationMs: plan.durationMs,
          pointerCount: plan.topology === 'two' ? 2 : 1,
          from: first,
          to: last,
          ...(backendResult ? { backendResult } : {}),
        } satisfies DaemonGestureResult;
      },
    },
  }),
});

import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import {
  createRequestHandler,
  gestureDeviceRuntimeGateway,
  gestureRuntimeSpies,
} from '../../__tests__/support/test-device-runtime-gateway.ts';
import type { SessionState } from '../../core/session-state.ts';
import { LeaseRegistry } from '../../resources/lease-registry.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import { makeTestScreenRecordingResource } from '../../__tests__/support/screen-recording-live-handle.ts';
import { mkdtempForTestSync, createTestHostEnvironment } from '@agent-device/test-kit';

// The observation spy hangs off the port the router composes with (ADR 0019 section 11), not off
// the platform module behind it.
const mockObserveRunnerSession = vi.fn();
const platformServices = daemonPlatformServicesFixture({
  appleSessionObservation: {
    observeRunnerSession: mockObserveRunnerSession,
    resolveSoleForegroundApp: async () => undefined,
  },
});

beforeEach(() => {
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  for (const spy of Object.values(gestureRuntimeSpies)) spy.mockClear();
  mockObserveRunnerSession.mockReset();
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
  sessionStore.publish('default', session);

  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    platformServices,
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
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
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
  sessionStore.publish('default', session);
  mockObserveRunnerSession.mockResolvedValue({
    alive: true,
    sessionId: 'runner-after',
  });
  const handler = createRequestHandler({
    host: createTestHostEnvironment(),
    createCommandSurface: testCreateCommandSurface,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    token: 'test-token',
    sessionStore,
    leaseRegistry: new LeaseRegistry(),
    deviceInventoryGateways: createTestDeviceInventoryGateways(),
    trackDownloadableArtifact: () => 'artifact-id',
    deviceRuntimeGateway: gestureDeviceRuntimeGateway,
    platformServices,
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
  expect(mockObserveRunnerSession).not.toHaveBeenCalled();
  expect(gestureRuntimeSpies.gestureViewport).toHaveBeenCalledOnce();
  expect(gestureRuntimeSpies.performMultiTouchGesturePlan).toHaveBeenCalledOnce();
  const recording = sessionStore.get('default')?.screenRecording?.handle.inspect();
  expect(recording?.invalidatedReason).toBeUndefined();
  expect(recording?.gestureEvents).toHaveLength(1);
  expect(recording?.gestureEvents[0]?.kind).toBe('pinch');
});
