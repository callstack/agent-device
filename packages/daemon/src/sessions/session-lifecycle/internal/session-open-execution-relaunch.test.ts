import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import {
  acquireDeviceClaim,
  inspectDeviceClaims,
} from '@agent-device/daemon-contracts/device-claims';
import type {
  LaunchConfirmationAbsent,
  LaunchConfirmationOutcome,
  OpenApplicationInput,
} from '@agent-device/contracts/application-lifecycle-runtime';
import {
  bindTestCommandHost,
  createLiveTestHostEnvironment,
  createTestHostEnvironment,
  mkdtempForTestSync,
} from '@agent-device/test-kit';
import { SessionStore } from '../../../core/session-store.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { refFrameState } from '../../../core/ref-frame.ts';
import { installProviderDeviceAdmission } from '../../../core/provider-device-admission.ts';
import { isDaemonIdle } from '../../server/daemon-idle-reap.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { lifecycleOperationsSpy } from '../../../__tests__/support/lifecycle-operations-spy.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
} from '../../../__tests__/support/handlers/session-command-harness.ts';

bindTestCommandHost();

const mockResolveTargetDevice = vi.hoisted(() => vi.fn());

vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/device-selection/dispatch-resolve')>();
  const { selectionFromResolveTargetDevice } =
    await import('../../../__tests__/support/device-selection-stub.ts');
  return {
    ...actual,
    resolveTargetDevice: mockResolveTargetDevice,
    resolveTargetDeviceSelection: vi.fn(selectionFromResolveTargetDevice(mockResolveTargetDevice)),
  };
});

const noopInvoke = async (_req: DaemonRequest): Promise<DaemonResponse> => ({ ok: true, data: {} });

const ANDROID_EMULATOR: DeviceInfo = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel Emulator',
  kind: 'emulator',
  booted: true,
};

const IOS_DEVICE: DeviceInfo = {
  platform: 'apple',
  appleOs: 'ios',
  id: 'ios-device-1',
  name: 'My iPhone',
  kind: 'device',
  booted: true,
};

const IOS_SIMULATOR: DeviceInfo = {
  ...IOS_DEVICE,
  id: 'sim-1',
  name: 'iPhone 17 Pro',
  kind: 'simulator',
};

beforeEach(() => {
  mockResolveTargetDevice.mockReset();
});

afterEach(() => {
  installProviderDeviceAdmission({ isActive: () => false });
});

function makeSessionStore(): SessionStore {
  const root = mkdtempForTestSync('agent-device-open-relaunch-');
  return new SessionStore(path.join(root, 'sessions'), createLiveTestHostEnvironment());
}

function publishSession(
  sessionStore: SessionStore,
  name: string,
  device: DeviceInfo,
  overrides: Partial<SessionState> = {},
): SessionState {
  const session: SessionState = {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
    appName: 'com.example.app',
    ...overrides,
  };
  sessionStore.publish(name, session);
  return session;
}

async function openRelaunch(params: {
  sessionStore: SessionStore;
  sessionName: string;
  positionals?: string[];
  flags?: Record<string, unknown>;
  onOpenApplication?: (input: OpenApplicationInput) => Promise<void> | void;
  openOutcome?: LaunchConfirmationOutcome | LaunchConfirmationAbsent;
}) {
  const opened: OpenApplicationInput[] = [];
  const boundDevices: DeviceInfo[] = [];
  const bindDevice: Parameters<typeof handleSessionCommands>[0]['bindDevice'] = async (
    device,
    use,
  ) => {
    boundDevices.push(device);
    const binding = await mockBindDeviceRuntime(device, use);
    return {
      ...binding,
      operations: {
        ...binding.operations,
        openApplication: async (input: OpenApplicationInput) => {
          opened.push(input);
          await params.onOpenApplication?.(input);
          return { appBundleId: input.appBundleId, timing: {}, ...params.openOutcome };
        },
      },
    };
  };
  const response = await handleSessionCommands({
    host: createTestHostEnvironment(),
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: {
      token: 't',
      session: params.sessionName,
      command: 'open',
      positionals: params.positionals ?? [],
      flags: { relaunch: true, ...params.flags },
    },
    sessionName: params.sessionName,
    logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
    sessionStore: params.sessionStore,
    invoke: noopInvoke,
    bindDevice,
  });
  return { response, opened, boundDevices };
}

test('open --relaunch asks the lifecycle to relaunch the active session app', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'android-session', ANDROID_EMULATOR);

  const { response, opened } = await openRelaunch({
    sessionStore,
    sessionName: 'android-session',
  });

  expect(response?.ok).toBe(true);
  expect(opened).toEqual([
    expect.objectContaining({
      relaunch: true,
      hasExistingSession: true,
      positionals: ['com.example.app'],
    }),
  ]);
});

test('open --relaunch leaves the old frame expired when the lifecycle fails (ADR 0014)', async () => {
  const sessionStore = makeSessionStore();
  const session = publishSession(sessionStore, 'android-session', ANDROID_EMULATOR, {
    snapshotGeneration: 400,
  });
  expect(refFrameState(session)).toBe('active');
  let frameWhenLifecycleRan: string | undefined;

  const response = await openRelaunch({
    sessionStore,
    sessionName: 'android-session',
    onOpenApplication: () => {
      frameWhenLifecycleRan = refFrameState(sessionStore.get('android-session')!);
      throw new Error('adb: close timed out after dispatch');
    },
  })
    .then((result) => result.response)
    .catch(() => null);

  expect(response?.ok ?? false).toBe(false);
  expect(frameWhenLifecycleRan).toBe('expired');
  expect(refFrameState(sessionStore.get('android-session')!)).toBe('expired');
});

test('failed relaunch retains the claim for close while allowing daemon idle reap', async () => {
  const claimsDir = mkdtempForTestSync('relaunch-claims-');
  const previousClaimsDir = process.env.AGENT_DEVICE_CLAIMS_DIR;
  process.env.AGENT_DEVICE_CLAIMS_DIR = claimsDir;
  try {
    const sessionStore = makeSessionStore();
    const sessionName = 'android-session';
    const acquired = await acquireDeviceClaim({
      env: process.env,
      device: ANDROID_EMULATOR,
      session: sessionName,
      workspace: process.cwd(),
      stateDir: sessionStore.resolveDaemonStateDir(),
      reconcileOrphanedDeviceClaim: async () => ({
        status: 'retained',
        reason: 'test-no-recovery',
      }),
    });
    if (acquired.status !== 'acquired') throw new Error('claim was not acquired');
    publishSession(sessionStore, sessionName, ANDROID_EMULATOR, {
      deviceClaim: acquired.ownership,
    });
    const claims = () => inspectDeviceClaims({ serial: ANDROID_EMULATOR.id }, process.env);
    expect(isDaemonIdle({ sessionStore, inFlightRequestCount: 0 })).toBe(false);

    await expect(
      openRelaunch({
        sessionStore,
        sessionName,
        onOpenApplication: () => {
          throw new Error('lifecycle dispatch failed');
        },
      }),
    ).rejects.toThrow('lifecycle dispatch failed');
    expect(sessionStore.get(sessionName)).toMatchObject({
      name: sessionName,
      deviceClaim: acquired.ownership,
    });
    expect(claims()[0]?.claim?.session).toBe(sessionName);
    expect(isDaemonIdle({ sessionStore, inFlightRequestCount: 0 })).toBe(true);

    expect((await openRelaunch({ sessionStore, sessionName })).response?.ok).toBe(true);
    expect(isDaemonIdle({ sessionStore, inFlightRequestCount: 0 })).toBe(false);
    await expect(
      openRelaunch({
        sessionStore,
        sessionName,
        onOpenApplication: () => {
          throw new Error('lifecycle dispatch failed again');
        },
      }),
    ).rejects.toThrow('lifecycle dispatch failed again');

    const { loader } = lifecycleOperationsSpy();
    const closed = await handleSessionCommands({
      host: createTestHostEnvironment(),
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      lifecycleOperationsLoader: loader,
      req: { token: 't', session: sessionName, command: 'close', positionals: [], flags: {} },
      sessionName,
      logPath: path.join(mkdtempForTestSync('daemon'), 'daemon.log'),
      sessionStore,
      invoke: noopInvoke,
    });
    expect(closed?.ok).toBe(true);
    expect(sessionStore.get(sessionName)).toBeUndefined();
    expect(claims()).toEqual([]);
    mockResolveTargetDevice.mockResolvedValue(ANDROID_EMULATOR);
    const reopened = await openRelaunch({
      sessionStore,
      sessionName,
      positionals: ['com.example.app'],
      flags: { platform: 'android' },
    });
    expect(reopened.response?.ok).toBe(true);
    expect(claims()[0]?.claim?.session).toBe(sessionName);
  } finally {
    if (previousClaimsDir === undefined) delete process.env.AGENT_DEVICE_CLAIMS_DIR;
    else process.env.AGENT_DEVICE_CLAIMS_DIR = previousClaimsDir;
  }
});

test('relaunch rejected before dispatch still keeps the daemon active', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'android-session', ANDROID_EMULATOR, { appName: undefined });
  const { response, opened } = await openRelaunch({ sessionStore, sessionName: 'android-session' });
  expect(response?.ok).toBe(false);
  expect(opened).toEqual([]);
  expect(isDaemonIdle({ sessionStore, inFlightRequestCount: 0 })).toBe(false);
});

test('open --relaunch does not let an ambient provider claim suppress the relaunch', async () => {
  const sessionStore = makeSessionStore();
  installProviderDeviceAdmission({ isActive: (device) => device.id === ANDROID_EMULATOR.id });
  mockResolveTargetDevice.mockResolvedValue(ANDROID_EMULATOR);

  const { response, opened, boundDevices } = await openRelaunch({
    sessionStore,
    sessionName: 'provider-android-session',
    positionals: ['com.example.app'],
    flags: { platform: 'android' },
  });

  expect(response?.ok).toBe(true);
  expect(boundDevices).toEqual([ANDROID_EMULATOR]);
  expect(opened).toEqual([expect.objectContaining({ relaunch: true, hasExistingSession: false })]);
});

test('open --relaunch without a session relaunches the requested app on the resolved device', async () => {
  const sessionStore = makeSessionStore();
  mockResolveTargetDevice.mockResolvedValue(IOS_DEVICE);

  const { response, opened, boundDevices } = await openRelaunch({
    sessionStore,
    sessionName: 'ios-new-session',
    positionals: ['com.example.app'],
    flags: { platform: 'ios' },
  });

  expect(response?.ok).toBe(true);
  expect(boundDevices).toEqual([IOS_DEVICE]);
  expect(opened).toEqual([
    expect.objectContaining({
      relaunch: true,
      hasExistingSession: false,
      positionals: ['com.example.app'],
    }),
  ]);
});

test('open <app> <url> --relaunch hands the lifecycle both positionals', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'ios-url-session', IOS_SIMULATOR);
  mockResolveTargetDevice.mockResolvedValue(IOS_SIMULATOR);

  const { response, opened } = await openRelaunch({
    sessionStore,
    sessionName: 'ios-url-session',
    positionals: ['com.example.app', 'https://example.com/deal'],
  });

  expect(response?.ok).toBe(true);
  expect(opened).toEqual([
    expect.objectContaining({
      relaunch: true,
      positionals: ['com.example.app', 'https://example.com/deal'],
    }),
  ]);
});

test.each([
  {
    reason: 'alert-unrecognized' as const,
    warning:
      /did not recognize \(alert-unrecognized\)[\s\S]*alert get[\s\S]*`alert accept` only when it is the launch confirmation/,
  },
  {
    reason: 'url-owner-unresolved' as const,
    warning: /could not be resolved[\s\S]*alert accept/,
  },
])(
  'open reports an unanswered $reason launch confirmation and appends its warning',
  async ({ reason, warning }) => {
    const sessionStore = makeSessionStore();
    publishSession(sessionStore, 'ios-confirmation-session', IOS_SIMULATOR);
    mockResolveTargetDevice.mockResolvedValue(IOS_SIMULATOR);

    const { response } = await openRelaunch({
      sessionStore,
      sessionName: 'ios-confirmation-session',
      openOutcome: {
        launchConfirmation: 'unanswered',
        launchConfirmationReason: reason,
      },
    });

    expect(response?.ok).toBe(true);
    if (response?.ok !== true) throw new Error('open must answer an unanswered confirmation');
    const data = response.data ?? {};
    expect(data.launchConfirmation).toBe('unanswered');
    expect(data.launchConfirmationReason).toBe(reason);
    expect(data.warnings).toEqual([expect.stringMatching(warning)]);
  },
);

test('open appends a probe-failure warning when the confirmation could not be read', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'ios-probe-session', IOS_SIMULATOR);
  mockResolveTargetDevice.mockResolvedValue(IOS_SIMULATOR);

  const { response } = await openRelaunch({
    sessionStore,
    sessionName: 'ios-probe-session',
    openOutcome: { launchConfirmationProbeFailure: 'alert-read' },
  });

  expect(response?.ok).toBe(true);
  if (response?.ok !== true) throw new Error('open must survive an unreadable probe');
  const data = response.data ?? {};
  expect('launchConfirmation' in data).toBe(false);
  expect(data.launchConfirmationProbeFailure).toBe('alert-read');
  expect(data.warnings).toEqual([
    expect.stringMatching(/could not read whether iOS is asking[\s\S]*alert get/),
  ]);
});

test('open --relaunch --clear-app-state hands the lifecycle the clear-state execution', async () => {
  const sessionStore = makeSessionStore();
  publishSession(sessionStore, 'ios-clear-state-session', IOS_SIMULATOR);
  mockResolveTargetDevice.mockResolvedValue(IOS_SIMULATOR);

  const { response, opened } = await openRelaunch({
    sessionStore,
    sessionName: 'ios-clear-state-session',
    flags: { clearAppState: true },
  });

  expect(response?.ok).toBe(true);
  expect(opened).toEqual([
    expect.objectContaining({
      relaunch: true,
      execution: expect.objectContaining({ clearAppState: true }),
    }),
  ]);
});
