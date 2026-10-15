import path from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import type { DaemonResponse } from '@agent-device/kernel/contracts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import type { OpenApplicationInput } from '@agent-device/contracts/application-lifecycle-runtime';
import { mkdtempForTestSync } from '@agent-device/test-kit/tmp-dir';
import { SessionStore } from '../../../core/session-store.ts';
import type { DaemonRequest } from '../../../core/daemon-request.ts';
import type { SessionState } from '../../../core/session-state.ts';
import { refFrameState } from '../../../core/ref-frame.ts';
import { installProviderDeviceAdmission } from '../../../core/provider-device-admission.ts';
import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';
import {
  handleSessionCommands,
  mockBindDeviceRuntime,
} from '../../../__tests__/support/handlers/session-command-harness.ts';

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
  return new SessionStore(path.join(root, 'sessions'));
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
          return { appBundleId: input.appBundleId, timing: {} };
        },
      },
    };
  };
  const response = await handleSessionCommands({
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
