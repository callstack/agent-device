import { test, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import type {
  ApplicationLifecycleRuntimeOperations,
  OpenApplicationInput,
  PostOpenObservation,
} from '@agent-device/contracts/application-lifecycle-runtime';

const { mockResolveTargetDevice, mockPrewarmRunnerSession } = vi.hoisted(() => ({
  mockResolveTargetDevice: vi.fn(),
  mockPrewarmRunnerSession: vi.fn(async () => {}),
}));

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../../daemon/__tests__/device-selection-stub.ts');
  return {
    ...actual,
    resolveTargetDevice: mockResolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(mockResolveTargetDevice)),
  };
});
vi.mock('../../../daemon/device/device-ready.ts', () => ({
  ensureDeviceReady: vi.fn(async () => {}),
}));
vi.mock('../../../platform-runtime-apple-application-tools.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../platform-runtime-apple-application-tools.ts')>();
  return {
    ...actual,
    createAppleApplicationTools: () => ({
      ...actual.createAppleApplicationTools(),
      prewarmRunnerSession: mockPrewarmRunnerSession,
    }),
  };
});
vi.mock('@agent-device/platform-apple/app-resolution', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/app-resolution')>();
  return { ...actual, resolveIosApp: vi.fn(async () => 'com.example.demo') };
});
vi.mock('@agent-device/platform-android/mechanics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/platform-android/mechanics')>();
  return {
    ...actual,
    activateAndroidTestIme: vi.fn(async () => ({ activated: false })),
    resolveAndroidPackageForOpen: vi.fn(async () => undefined),
  };
});
vi.mock('@agent-device/host-kit/process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/process')>();
  return { ...actual, readProcessStartTime: vi.fn(() => 'test-process-start') };
});

import { composedPlatformServicesFixture } from '../platform-services-fixture.ts';
import { fakeCreateCommandSurface } from '../../../daemon/__tests__/support/command-surface-fake.ts';
import {
  handleSessionCommands as handleHarnessSessionCommands,
  mockBindDeviceRuntime,
} from '../../../daemon/handlers/__tests__/session-command-harness.ts';
import {
  composedLifecycleRuntimeFixture,
  dispatchApplicationLifecycleEffect,
} from '../application-lifecycle-runtime-fixture.ts';
import { pendingSurfaceStabilization } from '../../../daemon/deferred-interaction-outcome.ts';

// The harness takes the lifecycle-operations loader per call, exactly like the gateway factories:
// these composition cases pass the REAL composed fixture instead of the daemon's canned default.
const handleSessionCommands = (params: Parameters<typeof handleHarnessSessionCommands>[0]) =>
  handleHarnessSessionCommands({
    ...params,
    lifecycleOperationsLoader: composedLifecycleRuntimeFixture,
  });
import {
  makeAppleSimulator,
  makeSessionStore,
  noopInvoke,
} from '../../../daemon/session-lifecycle/internal/__tests__/session-open-runtime.fixtures.ts';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';

const mockDispatch = vi.mocked(dispatchApplicationLifecycleEffect);

// These cases pin the REAL composed runner staging around an open (the post-open prewarm calls
// below) and how the daemon records the settle consequence of an open's observation timing
// (postOpenObservation). The observation verdict itself is a canned per-case answer injected at
// the binding seam, because the composed probe needs a live Simulator bridge; what the REAL Apple
// open reports into its timing for each verdict (observable / unobservable / probe-failed with
// typed failure) is pinned by the platform's own lane in
// `packages/platform-apple/src/lifecycle.test.ts`.
beforeEach(() => {
  vi.clearAllMocks();
  mockDispatch.mockImplementation(async () => ({}));
});

async function openReportingObservation(
  sessionName: string,
  postOpenObservation: PostOpenObservation,
) {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue(makeAppleSimulator());
  const bindDefault = mockBindDeviceRuntime.getMockImplementation();
  if (!bindDefault) throw new Error('the harness binds a default runtime');
  mockBindDeviceRuntime.mockImplementationOnce(async (device, use, loader) => {
    const binding = await bindDefault(device, use, loader);
    const operations = binding.operations as ApplicationLifecycleRuntimeOperations;
    return {
      ...binding,
      operations: {
        ...binding.operations,
        openApplication: async (input: OpenApplicationInput) => {
          const outcome = await operations.openApplication(input);
          return { ...outcome, timing: { ...outcome.timing, postOpenObservation } };
        },
      },
    };
  });

  const response = await handleSessionCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: composedPlatformServicesFixture(),
    req: {
      token: 't',
      session: sessionName,
      command: 'open',
      positionals: ['Demo'],
      flags: { platform: 'ios' },
    },
    sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore,
    invoke: noopInvoke,
  });
  expect(response?.ok).toBe(true);
  expect(mockPrewarmRunnerSession).toHaveBeenCalledTimes(1);
  expect(mockPrewarmRunnerSession).toHaveBeenCalledWith(
    expect.objectContaining({ platform: 'apple', kind: 'simulator' }),
    expect.any(Object),
    expect.any(AbortSignal),
    false,
  );
  return sessionStore.get(sessionName);
}

test('a fresh iOS open that could not observe its app leaves the next capture to settle', async () => {
  const session = await openReportingObservation('unobserved-open', 'unobservable');

  expect(pendingSurfaceStabilization(session)?.action).toBe('open');
});

test('a fresh iOS open whose observation probe failed leaves the next capture to settle', async () => {
  const session = await openReportingObservation('probe-failed-open', 'probe-failed');

  expect(pendingSurfaceStabilization(session)?.action).toBe('open');
});

test('a fresh iOS open that observed its app leaves nothing pending', async () => {
  const session = await openReportingObservation('observed-open', 'observable');

  expect(pendingSurfaceStabilization(session)).toBeUndefined();
});
