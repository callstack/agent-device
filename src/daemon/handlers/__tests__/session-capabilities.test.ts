import { test, expect, vi } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { PUBLIC_COMMANDS } from '../../../command-catalog.ts';
import { LINUX_DEVICE, WEB_DESKTOP_DEVICE } from '../../../__tests__/test-utils/device-fixtures.ts';
import {
  makeAndroidSession,
  makeSession,
} from '../../../__tests__/test-utils/session-factories.ts';
import { makeSessionStore } from '../../../__tests__/test-utils/store-factory.ts';
import { withTestDeviceInventoryProvider as withTargetDeviceResolutionScope } from '../../../__tests__/test-utils/device-inventory-gateways.ts';
import { unavailableDeploymentSnapshotAndShutdownOperationFacts } from '../../../__tests__/test-utils/runtime-operation-facts.ts';
import type { DeviceInfo } from '@agent-device/kernel/device';
import { applicationLifecycleOperationFacts } from '@agent-device/contracts/application-lifecycle-runtime';
import {
  type DeviceBinding,
  type RuntimeOperationFact,
  type RuntimeProviderMode,
  localRuntimeOwner,
  narrowDeviceBinding,
  providerRuntimeOwner,
} from '@agent-device/contracts/platform-runtime';
import type { PlatformRuntimeOperations } from '@agent-device/contracts/platform-runtime-operations';
import { screenshotRuntimeOperationFacts } from '@agent-device/contracts/screenshot-runtime';
import type {
  BindDeviceRuntime,
  InspectDeviceRuntimeFacts,
} from '../../request-runtime-binding.ts';
import { handleSessionCommands } from './session-command-harness.ts';

function assertAndroidCapabilityHonesty(availableCommands: unknown): void {
  expect(availableCommands).toContain(PUBLIC_COMMANDS.open);
  expect(availableCommands).toContain(PUBLIC_COMMANDS.close);
  expect(availableCommands).not.toContain(PUBLIC_COMMANDS.prepare);
  expect(availableCommands).not.toContain(PUBLIC_COMMANDS.viewport);
}

test('capabilities reports supported commands for the selected session device', async () => {
  const sessionName = 'android-capabilities';
  const sessionStore = makeSessionStore('agent-device-capabilities-');
  sessionStore.set(sessionName, makeAndroidSession(sessionName));
  const runtime = createAdmissionRuntime({
    appLogAvailable: true,
    ensureReadyAvailable: true,
    networkAvailable: true,
    appsAvailable: true,
    providerMode: 'local',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: PUBLIC_COMMANDS.capabilities,
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;

  expect(response.data?.device).toMatchObject({
    platform: 'android',
    kind: 'emulator',
  });
  expect(response.data?.availableCommands).toEqual(
    expect.arrayContaining([
      'open',
      'screenshot',
      'snapshot',
      'appstate',
      'press',
      'fill',
      'network',
      PUBLIC_COMMANDS.apps,
      'perf',
      PUBLIC_COMMANDS.logs,
      PUBLIC_COMMANDS.gesture,
    ]),
  );
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.capabilities);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.devices);
  assertAndroidCapabilityHonesty(response.data?.availableCommands);
  expect(runtime.inspections).toHaveLength(1);
  expect(runtime.uses).toEqual([
    { required: [], preferred: ['appLogInspect'] },
    { required: [], preferred: ['networkDump'] },
    { required: [], preferred: ['screenRecordingStart'] },
  ]);
});

test('capabilities excludes logs from an unavailable provider-mode XCTest runtime fact', async () => {
  const sessionName = 'provider-xctest-capabilities';
  const sessionStore = makeSessionStore('agent-device-capabilities-provider-xctest-');
  sessionStore.set(sessionName, {
    name: sessionName,
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'provider-ios-device',
      name: 'Provider iPhone',
      kind: 'device',
      iosPhysicalDeviceBackend: 'xctest',
    },
    createdAt: Date.now(),
    actions: [],
  });
  const runtime = createAdmissionRuntime({
    appLogAvailable: false,
    networkAvailable: true,
    appsAvailable: false,
    providerMode: 'provider-runtime',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: PUBLIC_COMMANDS.capabilities,
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  const availableCommands = response.data?.availableCommands;
  expect(availableCommands).not.toContain(PUBLIC_COMMANDS.logs);
  expect(availableCommands).not.toContain(PUBLIC_COMMANDS.apps);
  expect(availableCommands).toContain(PUBLIC_COMMANDS.network);
  expect(availableCommands).not.toContain(PUBLIC_COMMANDS.open);
  expect(availableCommands).not.toContain(PUBLIC_COMMANDS.close);
  expect(availableCommands).not.toContain(PUBLIC_COMMANDS.prepare);
  expect(availableCommands).not.toContain(PUBLIC_COMMANDS.shutdown);
  expect(runtime.inspections).toHaveLength(1);
  expect(runtime.uses).toEqual([
    { required: [], preferred: ['appLogInspect'] },
    { required: [], preferred: ['networkDump'] },
    { required: [], preferred: ['screenRecordingStart'] },
  ]);
});

test('capabilities excludes network when the runtime fact is unavailable', async () => {
  const sessionName = 'android-capabilities-no-network';
  const sessionStore = makeSessionStore('agent-device-capabilities-no-network-');
  sessionStore.set(sessionName, makeAndroidSession(sessionName));
  const runtime = createAdmissionRuntime({
    appLogAvailable: true,
    networkAvailable: false,
    appsAvailable: false,
    providerMode: 'local',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: PUBLIC_COMMANDS.capabilities,
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  expect(response.data?.availableCommands).toContain(PUBLIC_COMMANDS.logs);
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.network);
});

test('capabilities includes apps for the available HarmonyOS runtime fact', async () => {
  const sessionName = 'harmony-capabilities';
  const sessionStore = makeSessionStore('agent-device-capabilities-harmony-');
  const harmonyDevice = {
    platform: 'harmonyos',
    id: 'harmony-capabilities',
    name: 'HarmonyOS device',
    kind: 'device',
    target: 'mobile',
    booted: true,
  } as const;
  sessionStore.set(sessionName, makeSession(sessionName, { device: harmonyDevice }));
  const runtime = createAdmissionRuntime({
    appLogAvailable: true,
    networkAvailable: false,
    appsAvailable: true,
    providerMode: 'local',
  });

  const response = await withTargetDeviceResolutionScope(
    async (request) => (request.platform === 'harmonyos' ? [harmonyDevice] : []),
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: sessionName,
          command: PUBLIC_COMMANDS.capabilities,
          positionals: [],
          flags: {},
        },
        sessionName,
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        bindDevice: runtime.bindDevice,
        inspectFacts: runtime.inspectFacts,
        invoke: async () => ({ ok: true, data: {} }),
      }),
  );

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  expect(response.data?.availableCommands).toContain(PUBLIC_COMMANDS.apps);
  expect(runtime.inspectFacts).toHaveBeenCalledOnce();
});

const APPS_UNAVAILABLE_CAPABILITY_CASES = [
  { label: 'Linux', device: LINUX_DEVICE, providerMode: 'local' },
  { label: 'Web', device: WEB_DESKTOP_DEVICE, providerMode: 'local' },
  {
    label: 'watchOS',
    device: {
      platform: 'apple',
      appleOs: 'watchos',
      id: 'watchos-capabilities',
      name: 'Apple Watch',
      kind: 'device',
      target: 'mobile',
    } satisfies DeviceInfo,
    providerMode: 'local',
  },
  {
    label: 'XCTest physical iOS',
    device: {
      platform: 'apple',
      appleOs: 'ios',
      id: 'xctest-capabilities',
      name: 'XCTest iPhone',
      kind: 'device',
      iosPhysicalDeviceBackend: 'xctest',
    } satisfies DeviceInfo,
    providerMode: 'provider-runtime',
  },
  {
    label: 'WebDriver',
    device: {
      ...WEB_DESKTOP_DEVICE,
      id: 'webdriver-capabilities',
      name: 'WebDriver browser',
    } satisfies DeviceInfo,
    providerMode: 'provider-runtime',
  },
] as const satisfies ReadonlyArray<{
  label: string;
  device: DeviceInfo;
  providerMode: RuntimeProviderMode;
}>;

test.each(APPS_UNAVAILABLE_CAPABILITY_CASES)(
  'capabilities omits apps when $label runtime facts deny the operation',
  async ({ label, device, providerMode }) => {
    const sessionName = `capabilities-${label.toLowerCase().replaceAll(' ', '-')}`;
    const sessionStore = makeSessionStore(`agent-device-capabilities-${label}-`);
    sessionStore.set(sessionName, makeSession(sessionName, { device }));
    const runtime = createAdmissionRuntime({
      appLogAvailable: false,
      networkAvailable: false,
      appsAvailable: false,
      providerMode,
    });

    const response = await handleSessionCommands({
      req: {
        token: 't',
        session: sessionName,
        command: PUBLIC_COMMANDS.capabilities,
        positionals: [],
        flags: {},
      },
      sessionName,
      logPath: path.join(os.tmpdir(), 'daemon.log'),
      sessionStore,
      bindDevice: runtime.bindDevice,
      inspectFacts: runtime.inspectFacts,
      invoke: async () => ({ ok: true, data: {} }),
    });

    expect(response?.ok).toBe(true);
    if (!response?.ok) return;
    expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.apps);
    expect(runtime.inspectFacts).toHaveBeenCalledOnce();
  },
);

test('capabilities excludes appstate when its runtime fact is unavailable', async () => {
  const sessionName = 'android-capabilities-no-appstate';
  const sessionStore = makeSessionStore('agent-device-capabilities-no-appstate-');
  sessionStore.set(sessionName, makeAndroidSession(sessionName));
  const runtime = createAdmissionRuntime({
    appLogAvailable: true,
    appStateAvailable: false,
    networkAvailable: true,
    providerMode: 'local',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: PUBLIC_COMMANDS.capabilities,
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    bindDevice: runtime.bindDevice,
    inspectFacts: runtime.inspectFacts,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.appState);
});

test('capabilities excludes appstate when its readiness fact is unavailable', async () => {
  const sessionName = 'android-capabilities-no-readiness';
  const sessionStore = makeSessionStore('agent-device-capabilities-no-readiness-');
  sessionStore.set(sessionName, makeAndroidSession(sessionName));
  const runtime = createAdmissionRuntime({
    appLogAvailable: true,
    appStateAvailable: true,
    ensureReadyAvailable: false,
    networkAvailable: true,
    providerMode: 'local',
  });

  const response = await handleSessionCommands({
    req: {
      token: 't',
      session: sessionName,
      command: PUBLIC_COMMANDS.capabilities,
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: path.join(os.tmpdir(), 'daemon.log'),
    sessionStore,
    bindDevice: runtime.bindDevice,
    inspectFacts: runtime.inspectFacts,
    invoke: async () => ({ ok: true, data: {} }),
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;
  expect(response.data?.availableCommands).not.toContain(PUBLIC_COMMANDS.appState);
});

test.each([
  [
    'iOS',
    {
      platform: 'apple' as const,
      appleOs: 'ios' as const,
      id: 'ios-capabilities',
      name: 'iPhone',
      kind: 'simulator' as const,
      target: 'mobile' as const,
      booted: true,
    },
  ],
  [
    'macOS',
    {
      platform: 'apple' as const,
      appleOs: 'macos' as const,
      id: 'macos-capabilities',
      name: 'Mac',
      kind: 'device' as const,
      target: 'desktop' as const,
      booted: true,
    },
  ],
])(
  'capabilities preserves session-owned appstate for an active %s session',
  async (_name, device) => {
    const sessionName = device.id + '-session';
    const sessionStore = makeSessionStore('agent-device-capabilities-' + device.id + '-');
    sessionStore.set(sessionName, {
      name: sessionName,
      device,
      createdAt: Date.now(),
      actions: [],
      appName: 'Settings',
      appBundleId: 'com.example.settings',
    });
    // The projection still reads one sessionless snapshot, because open/close/prepare/runtime
    // availability is a runtime fact. What the session owns is the appstate answer itself, so a
    // snapshot that reports appstate unavailable must not remove the command.
    const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(
      async (inspected: DeviceInfo) =>
        createAdmissionBinding(inspected, {
          appLogAvailable: false,
          appStateAvailable: false,
          networkAvailable: false,
          providerMode: 'local',
        }).facts,
    );

    const response = await withTargetDeviceResolutionScope(
      async () => [device],
      async () =>
        await handleSessionCommands({
          req: {
            token: 't',
            session: sessionName,
            command: PUBLIC_COMMANDS.capabilities,
            positionals: [],
            flags: {},
          },
          sessionName,
          logPath: path.join(os.tmpdir(), 'daemon.log'),
          sessionStore,
          inspectFacts,
          invoke: async () => ({ ok: true, data: {} }),
        }),
    );

    expect(response?.ok).toBe(true);
    if (!response?.ok) return;
    expect(response.data?.availableCommands).toContain(PUBLIC_COMMANDS.appState);
    expect(inspectFacts).toHaveBeenCalledTimes(1);
  },
);

test('capabilities accepts a stopped Android AVD placeholder for explicit platform discovery', async () => {
  const stoppedAvd: DeviceInfo = {
    platform: 'android',
    id: 'Pixel_8_API_35',
    name: 'Pixel 8 API 35',
    kind: 'emulator',
    booted: false,
  };
  const sessionStore = makeSessionStore('agent-device-capabilities-stopped-avd-');

  const response = await withTargetDeviceResolutionScope(
    async (request) => (request.platform === 'android' ? [stoppedAvd] : []),
    async () =>
      await handleSessionCommands({
        req: {
          token: 't',
          session: 'default',
          command: PUBLIC_COMMANDS.capabilities,
          positionals: [],
          flags: { platform: 'android' },
        },
        sessionName: 'default',
        logPath: path.join(os.tmpdir(), 'daemon.log'),
        sessionStore,
        invoke: async () => ({ ok: true, data: {} }),
      }),
  );

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;

  expect(response.data?.device).toMatchObject({
    platform: 'android',
    id: 'Pixel_8_API_35',
    kind: 'emulator',
    booted: false,
  });
  expect(response.data?.availableCommands).toEqual(
    expect.arrayContaining(['open', 'screenshot', 'snapshot', 'press', 'fill']),
  );
  expect(response.data?.availableCommands).toContain(PUBLIC_COMMANDS.shutdown);
});

function createAdmissionRuntime(options: {
  appLogAvailable: boolean;
  appStateAvailable?: boolean;
  ensureReadyAvailable?: boolean;
  networkAvailable: boolean;
  appsAvailable?: boolean;
  screenshotAvailable?: boolean;
  providerMode: RuntimeProviderMode;
}) {
  const uses: Array<{
    required: readonly string[];
    preferred: readonly string[];
    conditional?: readonly string[];
  }> = [];
  const inspections: DeviceInfo[] = [];
  const inspectFacts: InspectDeviceRuntimeFacts = vi.fn(async (device: DeviceInfo) => {
    inspections.push(device);
    return createAdmissionBinding(device, options).facts;
  });
  const bindDevice: BindDeviceRuntime = async (device, use) => {
    uses.push({
      required: [...use.required],
      preferred: [...use.preferred],
      ...(use.conditional === undefined ? {} : { conditional: [...use.conditional] }),
    });
    return narrowDeviceBinding(createAdmissionBinding(device, options), use);
  };
  return { bindDevice, inspectFacts, inspections, uses };
}

type AdmissionRuntimeOptions = Readonly<{
  appLogAvailable: boolean;
  appStateAvailable?: boolean;
  ensureReadyAvailable?: boolean;
  networkAvailable: boolean;
  appsAvailable?: boolean;
  /** `screenshot` is fact-owned since R39; the projection reads this cell, not a bucket. */
  screenshotAvailable?: boolean;
  providerMode: RuntimeProviderMode;
}>;

function createAdmissionBinding(
  device: DeviceInfo,
  options: AdmissionRuntimeOptions,
): DeviceBinding<PlatformRuntimeOperations> {
  const unavailable = unavailableOperationFact(options.providerMode);
  const appsFact = appsOperationFact(options);
  const lifecycleAvailable = admissionLifecycleAvailable(device, options.providerMode);
  return {
    device,
    owner: createAdmissionOwner(device, options.providerMode),
    facts: createAdmissionFacts(device, options, unavailable, appsFact, lifecycleAvailable),
    operations: createAdmissionOperations(options, lifecycleAvailable),
    [Symbol.asyncDispose]: async () => {},
  };
}

function admissionLifecycleAvailable(
  device: DeviceInfo,
  providerMode: RuntimeProviderMode,
): boolean {
  return providerMode === 'local' && device.platform === 'android';
}

function createAdmissionOwner(device: DeviceInfo, providerMode: RuntimeProviderMode) {
  return providerMode === 'provider-runtime'
    ? providerRuntimeOwner('test', 'capabilities')
    : localRuntimeOwner(device.platform);
}

function createAdmissionFacts(
  device: DeviceInfo,
  options: AdmissionRuntimeOptions,
  unavailable: ReturnType<typeof unavailableOperationFact>,
  appsFact: ReturnType<typeof appsOperationFact>,
  lifecycleAvailable: boolean,
) {
  return {
    device: {
      family: device.platform,
      ...(device.appleOs === undefined ? {} : { appleOs: device.appleOs }),
      kind: device.kind,
      ...(device.target === undefined ? {} : { target: device.target }),
      ...(device.iosPhysicalDeviceBackend === undefined
        ? {}
        : { iosPhysicalDeviceBackend: device.iosPhysicalDeviceBackend }),
      providerMode: options.providerMode,
    },
    operations: createAdmissionOperationFacts(options, unavailable, appsFact, lifecycleAvailable),
  };
}

function createAdmissionOperationFacts(
  options: AdmissionRuntimeOptions,
  unavailable: ReturnType<typeof unavailableOperationFact>,
  appsFact: ReturnType<typeof appsOperationFact>,
  lifecycleAvailable: boolean,
) {
  return {
    ...unavailableDeploymentSnapshotAndShutdownOperationFacts,
    ...screenshotRuntimeOperationFacts({
      capture: options.screenshotAvailable === false ? unavailable : { available: true as const },
    }),
    appLogInspect: options.appLogAvailable ? { available: true as const } : unavailable,
    appLogDoctor: unavailable,
    appLogStart: unavailable,
    appLogReattach: unavailable,
    appLogCleanup: unavailable,
    appState:
      (options.appStateAvailable ?? options.appLogAvailable)
        ? { available: true as const }
        : unavailable,
    networkDump: options.networkAvailable ? { available: true as const } : unavailable,
    screenRecordingStart: unavailable,
    screenRecordingReattach: unavailable,
    screenRecordingCleanup: unavailable,
    ensureReady:
      options.ensureReadyAvailable === undefined
        ? appsFact
        : options.ensureReadyAvailable
          ? { available: true as const }
          : unavailable,
    bootTarget: unavailable,
    bootTargetHeadless: unavailable,
    listApps: appsFact,
    ...admissionLifecycleFacts(lifecycleAvailable, unavailable),
  };
}

function createAdmissionOperations(options: AdmissionRuntimeOptions, lifecycleAvailable: boolean) {
  return {
    ...(options.appLogAvailable ? { appLogInspect: inspectAndroidAppLog } : {}),
    ...(options.networkAvailable ? { networkDump: dumpEmptyAndroidNetwork } : {}),
    ...(lifecycleAvailable ? lifecycleOperations : {}),
  };
}

function admissionLifecycleFacts(lifecycleAvailable: boolean, unavailable: RuntimeOperationFact) {
  const lifecycleFact = lifecycleAvailable ? ({ available: true } as const) : unavailable;
  return applicationLifecycleOperationFacts({
    resolveOpenTarget: lifecycleFact,
    prepareApplicationOpen: lifecycleFact,
    openApplication: lifecycleFact,
    applyRuntimeHints: lifecycleFact,
    clearRuntimeHints: lifecycleFact,
    closeApplication: lifecycleFact,
    finalizeApplicationClose: lifecycleFact,
    prepareAppleRunner: unavailable,
    configureProviderPortReverse: unavailable,
  });
}

const lifecycleOperations = {
  resolveOpenTarget: async () => ({}),
  prepareApplicationOpen: async () => {},
  openApplication: async () => ({ timing: {} }),
  applyRuntimeHints: async () => {},
  clearRuntimeHints: async () => {},
  closeApplication: async () => {},
  finalizeApplicationClose: async () => {},
};

function unavailableOperationFact(providerMode: RuntimeProviderMode) {
  return {
    available: false as const,
    reason:
      providerMode === 'provider-runtime'
        ? ('unsupported-provider-mode' as const)
        : ('owner-capability-missing' as const),
  };
}

function appsOperationFact(options: AdmissionRuntimeOptions) {
  return options.appsAvailable
    ? ({ available: true } as const)
    : unavailableOperationFact(options.providerMode);
}

const inspectAndroidAppLog: PlatformRuntimeOperations['appLogInspect'] = async () => ({
  backend: 'android',
});

const dumpEmptyAndroidNetwork: PlatformRuntimeOperations['networkDump'] = async (input) => ({
  source: 'app-log',
  backend: 'android',
  dump: {
    path: '/tmp/app.log',
    exists: false,
    scannedLines: 0,
    matchedLines: 0,
    entries: [],
    include: input.include,
    limits: {
      maxEntries: input.maxEntries,
      maxPayloadChars: input.maxPayloadChars,
      maxScanLines: input.maxScanLines,
    },
  },
  notes: [],
});
