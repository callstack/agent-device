import { daemonPlatformServicesFixture } from '../../__tests__/support/platform-services-fixture.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { expect, test, vi } from 'vitest';
import { resolveSnapshotRuntimePlan } from '@agent-device/contracts/platform-runtime-operations';
import { IOS_SIMULATOR } from '@agent-device/test-kit';
import { makeAndroidSession, makeIosSession } from '../../__tests__/support/session-factories.ts';
import { makeSessionStore } from '../../__tests__/support/store-factory.ts';
import type { BindDeviceRuntime } from '../request-runtime-binding.ts';
import {
  admitAndBindSnapshotCapture,
  resolveBoundSnapshotCaptureRuntime,
} from '../snapshot-runtime-binding.ts';
import type { DaemonRequest } from '../daemon-request.ts';
import { snapshotRuntimeFixture } from '../../__tests__/support/snapshot-runtime-fixture.ts';
import { ensureDeviceReady } from '../device/device-ready.ts';
import { fakeCreateCommandSurface } from '../../__tests__/support/command-surface-fake.ts';
import type {
  CaptureSnapshotInput,
  SnapshotResult,
} from '@agent-device/contracts/snapshot-runtime';
import type { SessionState } from '../session-state.ts';
import { markSessionSnapshotOutdated } from '../ref-frame.ts';
import {
  clearAndroidSnapshotFreshness,
  markAndroidSnapshotFreshness,
} from '../session-snapshot-freshness.ts';
import { markDeferredInteractionOutcome } from '../deferred-interaction-outcome.ts';

vi.mock('../device/device-ready.ts', () => ({ ensureDeviceReady: vi.fn(async () => {}) }));

const mockEnsureDeviceReady = vi.mocked(ensureDeviceReady);

// The owning interface (ADR 0019 §9): one plan, one facts-first admission, one bind — and the
// bind target is whatever the admission was minted for, read back by token identity. The binder
// itself is module-private; this is its only entry.
test('the owning interface binds exactly the session device the facts were admitted for', async () => {
  const { inspectFacts, bindDevice } = snapshotRuntimeFixture();
  const boundDevices: DeviceInfo[] = [];
  const recordingBind: BindDeviceRuntime = async (device, use) => {
    boundDevices.push(device);
    return await bindDevice(device, use);
  };
  const sessionStore = makeSessionStore();
  // An active app: the fixture admits captureSnapshot for a local iOS simulator only with one.
  sessionStore.publish(
    'bind-test',
    makeIosSession('bind-test', { device: IOS_SIMULATOR, appBundleId: 'com.example.app' }),
  );
  const req: DaemonRequest = {
    command: 'snapshot',
    positionals: [],
    session: 'bind-test',
    token: 'test-token',
  };

  const resolved = await resolveBoundSnapshotCaptureRuntime(
    {
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      req,
      sessionName: 'bind-test',
      logPath: '/tmp/bind-test.log',
      sessionStore,
      inspectFacts,
      bindDevice: recordingBind,
    },
    'snapshot',
  );

  expect(resolved.ok).toBe(true);
  expect(boundDevices).toEqual([IOS_SIMULATOR]);
});

test('sessionless capture readiness follows runtime binding', async () => {
  const fixture = snapshotRuntimeFixture();
  const events: string[] = [];
  mockEnsureDeviceReady.mockReset();
  mockEnsureDeviceReady.mockImplementation(async () => {
    events.push('ready');
  });
  const recordingBind: BindDeviceRuntime = async (device, use) => {
    events.push('bind');
    return await fixture.bindDevice(device, use);
  };

  const resolved = await admitAndBindSnapshotCapture({
    platformServices: daemonPlatformServicesFixture(),
    command: 'snapshot',
    device: IOS_SIMULATOR,
    session: undefined,
    plan: resolveSnapshotRuntimePlan({ customActions: false, hasActiveApp: true }),
    inspectFacts: fixture.inspectFacts,
    bindDevice: recordingBind,
    readiness: true,
  });

  expect(resolved.ok).toBe(true);
  expect(events).toEqual(['bind', 'ready']);
});

test('snapshot and diff shorten idle only when every observation guard still holds at capture', async () => {
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
  const cases: {
    name: string;
    apple?: boolean;
    beforeCapture?: (session: SessionState) => void;
    short: boolean;
  }[] = [
    { name: 'current Android observation at the 500 ms boundary', short: true },
    { name: 'non-Android observation', apple: true, short: false },
    {
      name: 'no stored tree',
      beforeCapture: (session) => {
        session.snapshot = undefined;
      },
      short: false,
    },
    { name: 'retired observation', beforeCapture: markSessionSnapshotOutdated, short: false },
    {
      name: '499 ms old observation',
      beforeCapture: (session) => {
        session.snapshot = { nodes: [], createdAt: now - 499 };
      },
      short: false,
    },
    {
      name: 'active freshness recovery',
      beforeCapture: (session) => {
        markAndroidSnapshotFreshness(session, 'press');
      },
      short: false,
    },
    {
      name: 'pending gesture stabilization without freshness recovery',
      beforeCapture: (session) => {
        markDeferredInteractionOutcome({
          session,
          command: 'scroll',
          positionals: ['down'],
          flags: undefined,
        });
        clearAndroidSnapshotFreshness(session);
      },
      short: false,
    },
  ];
  try {
    for (const command of ['snapshot', 'diff'] as const) {
      for (const scenario of cases) {
        const fixture = snapshotRuntimeFixture();
        const capture = vi.fn<(input: CaptureSnapshotInput) => Promise<SnapshotResult>>(async () =>
          scenario.apple
            ? { backend: 'xctest', producer: 'simulator-ax-bridge', nodes: [] }
            : { backend: 'android', producer: 'android-uiautomator', nodes: [] },
        );
        const bindDevice: BindDeviceRuntime = async (device, use) => {
          const runtime = await fixture.bindDevice(device, use);
          return {
            ...runtime,
            operations: {
              ...runtime.operations,
              captureSnapshot: capture,
              captureSnapshotWithoutActiveApp: capture,
            },
          };
        };
        const make = scenario.apple ? makeIosSession : makeAndroidSession;
        const sessionStore = makeSessionStore();
        sessionStore.publish(
          'idle-policy',
          make('idle-policy', {
            appBundleId: 'com.example.app',
            snapshot: { nodes: [], createdAt: now - 500 },
          }),
        );
        const resolved = await resolveBoundSnapshotCaptureRuntime(
          {
            createCommandSurface: fakeCreateCommandSurface,
            platformServices: fixture.platformServices,
            req: { command, positionals: [], session: 'idle-policy', token: 'test-token' },
            sessionName: 'idle-policy',
            logPath: '/tmp/idle-policy.log',
            sessionStore,
            inspectFacts: fixture.inspectFacts,
            bindDevice,
          },
          command,
        );
        expect(resolved.ok, scenario.name).toBe(true);
        if (!resolved.ok || !resolved.session) throw new Error('Expected a bound app session');
        scenario.beforeCapture?.(resolved.session);
        await resolved.captureSnapshot();
        expect(capture, scenario.name).toHaveBeenCalledOnce();
        expect(
          capture.mock.calls[0]?.[0].options?.captureBasis,
          `${command}: ${scenario.name}`,
        ).toBe(scenario.short ? 'unchanged-since-observation' : undefined);
      }
    }
  } finally {
    clock.mockRestore();
  }
});
