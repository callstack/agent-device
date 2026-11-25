import { expect, test, vi } from 'vitest';
import { buildGesturePlan } from '@agent-device/gestures/gesture-plan';
import { attachRefs } from '@agent-device/kernel/snapshot';
import {
  makeAndroidSession,
  makeIosSession,
} from '../../../__tests__/support/session-factories.ts';
import { clearAndroidObservationFixture } from '../../../__tests__/support/android-observation-fixture.ts';
import { makeSessionStore } from '../../../__tests__/support/store-factory.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { createTouchCommandSurface } from '../../../__tests__/support/touch-command-surface-fake.ts';
import { pendingSurfaceStabilization } from '../../../core/deferred-interaction-outcome.ts';
import { activateCompleteRefFrame, refFrameScope, refFrameState } from '../../../core/ref-frame.ts';
import { setSessionSnapshot } from '../../session-snapshot.ts';
import { handleInteractionCommands } from '../index.ts';
import { gestureRuntimeBindingsFixture } from './__tests__/gesture-runtime-bindings.fixtures.ts';

test.each([
  { command: 'swipe', settle: false, settled: false, surface: 'app' },
  { command: 'swipe', settle: true, settled: true, surface: 'app' },
  { command: 'gesture', settle: true, settled: false, surface: 'app' },
  { command: 'swipe', settle: true, settled: true, surface: 'android overlay' },
  { command: 'swipe', settle: true, settled: true, surface: 'retired session' },
] as const)(
  '$command with settle=$settle, quiet=$settled and $surface observes only after the series',
  async ({ command, settle, settled, surface }) => {
    const sessionName = 'gesture-settle';
    const overlay = surface === 'android overlay';
    const retired = surface === 'retired session';
    const makeSession = overlay ? makeAndroidSession : makeIosSession;
    const session = makeSession(sessionName, { appBundleId: 'com.example.app' });
    const sessionStore = makeSessionStore();
    const ref = sessionStore.publish(sessionName, session);
    const before = attachRefs([{ index: 0, type: 'Button', label: 'Before' }]);
    const after = attachRefs([{ index: 0, type: 'Button', label: 'After' }]);
    setSessionSnapshot(session, { nodes: before, backend: 'xctest', createdAt: 0 });
    activateCompleteRefFrame(session);
    const gestures = gestureRuntimeBindingsFixture();
    const from = { x: 120, y: 220 };
    const to = { x: 120, y: 320 };
    const dispatches = vi.fn(async () => ({}));
    for (const operation of [
      gestures.performGesturePlan,
      gestures.performDirectionalFlingPlan,
      gestures.performMultiTouchGesturePlan,
    ]) {
      operation.mockImplementation(dispatches);
    }
    const observe = vi.fn();
    const response = await handleInteractionCommands({
      createCommandSurface: createTouchCommandSurface({
        members: (config) => ({
          interactions: {
            gesture: async ({ session, gesture }) => {
              if (gesture.intent === 'drag' || 'element' in gesture)
                throw new Error('Expected coordinates');
              const context = { session };
              const viewport = await config.backend.resolveGestureViewport!(context);
              const plan = buildGesturePlan(gesture, viewport!, overlay ? 'android' : 'ios');
              await config.backend.performGesture!(context, plan);
              return {
                kind: gesture.intent,
                durationMs: plan.durationMs,
                from,
                to,
                pointerCount: 1,
              };
            },
            settleObservation: async (options) => {
              observe(options);
              expect(dispatches).toHaveBeenCalledTimes(2);
              expect(session.actions).toHaveLength(1);
              expect(pendingSurfaceStabilization(session)).toBeDefined();
              expect(refFrameState(session)).toBe('expired');
              await config.backend.captureSnapshot?.({ session: sessionName });
              if (retired) sessionStore.retire(ref);
              return {
                settled,
                waitedMs: settled ? 25 : 100,
                captures: 1,
                quietMs: options.quietMs!,
                timeoutMs: options.timeoutMs!,
                ...(settled
                  ? {
                      diff: {
                        summary: { additions: 1, removals: 1, unchanged: 0 },
                        lines: [{ kind: 'added', text: '@e1 Button "After"', ref: 'e1' }],
                      },
                    }
                  : {}),
              };
            },
          },
        }),
      }),
      captureSnapshotForSession: async (_ref, _flags, _store, _context, options) => {
        await options.boundCapture!({ execution: {} });
        const snapshot = {
          nodes: after,
          backend: overlay ? ('android' as const) : ('xctest' as const),
          createdAt: 1,
          ...(overlay ? { systemSurface: { kind: 'android-system-overlay' as const } } : {}),
        };
        setSessionSnapshot(session, snapshot);
        return snapshot;
      },
      platformServices: daemonPlatformServicesFixture(),
      androidObservation: clearAndroidObservationFixture,
      req: {
        token: 't',
        session: sessionName,
        command,
        positionals: [],
        flags: settle ? { settle: true, settleQuietMs: 25, timeoutMs: 100 } : {},
        input:
          command === 'swipe'
            ? { from, to, count: 2 }
            : { kind: 'tap', points: [from, to], count: 2 },
      },
      sessionName,
      sessionStore,
      contextFromFlags: () => ({}),
      inspectFacts: gestures.inspectFacts,
      bindDevice: gestures.bindDevice,
    });
    expect(response).toMatchObject({ ok: true, data: { count: 2 } });
    if (!response?.ok) return;
    expect(dispatches).toHaveBeenCalledTimes(2);
    expect(gestures.inspectFacts).toHaveBeenCalledOnce();
    expect(gestures.bindDevice).toHaveBeenCalledOnce();
    expect(observe).toHaveBeenCalledTimes(settle ? 1 : 0);
    expect(gestures.captureSnapshot).toHaveBeenCalledTimes(settle ? 1 : 0);
    if (settle) {
      expect(observe).toHaveBeenCalledWith(
        expect.objectContaining({
          baseline: expect.objectContaining({ nodes: before }),
          quietMs: 25,
          timeoutMs: 100,
        }),
      );
      expect(response.data?.settle).toMatchObject({ settled: settled && !retired, captures: 1 });
    }
    if (settled && !overlay && !retired) {
      expect(response.data?.settle).toMatchObject({ refsGeneration: session.snapshotGeneration });
      expect(refFrameState(session)).toBe('active');
      expect(refFrameScope(session)).toEqual(new Set(['e1']));
    } else {
      expect(response.data?.settle ?? {}).not.toHaveProperty('refsGeneration');
      expect(response.data?.settle ?? {}).not.toHaveProperty('diff');
      expect(refFrameState(session)).toBe('expired');
    }
  },
);
