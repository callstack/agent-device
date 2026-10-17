import { daemonPlatformServicesFixture } from '../../../__tests__/support/platform-services-fixture.ts';
import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { legacyDispatchCapture } from '../../../__tests__/support/legacy-snapshot-capture-fixture.ts';
import { handleSnapshotCommands as handleProductionSnapshotCommands } from '../../../sessions/handlers/snapshot.ts';
import { providerDeviceAdmissionFixture } from '../../../__tests__/support/provider-device-admission-fixture.ts';
import { fakeCreateCommandSurface } from '../../../__tests__/support/command-surface-fake.ts';

// The daemon reads provider ownership through its own typed admission seam; these suites
// install the seam over runtime fakes, the way root composition installs the real one.
const providerAdmission = providerDeviceAdmissionFixture();
import { platformResourceCleanupFixture } from '../../../__tests__/support/platform-resource-cleanup-fixture.ts';
import {
  fixtureSettingsMutations,
  fixtureSettingsReads,
  resetSnapshotRuntimeFixture,
  snapshotRuntimeFixture,
} from '../../../__tests__/support/snapshot-runtime-fixture.ts';
import {
  androidDevice,
  iosSimulatorDevice,
  macOsDevice,
  makeSession,
  makeSessionStore,
  snapshotRequest,
  tvOsSimulatorDevice,
} from '../../../__tests__/support/handlers/snapshot-handler.fixtures.ts';
import { activateCompleteRefFrame, refFrameState } from '../../../core/ref-frame.ts';
import { PRE_DISPATCH_REFUSAL_REASONS } from '@agent-device/kernel/errors';

vi.mock('../../../core/snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../../__tests__/support/legacy-snapshot-capture-fixture.ts');
  return { captureSnapshotWithInteractor: fixture.captureSnapshotThroughLegacyDispatchFixture };
});
vi.mock('@agent-device/platform-apple/runner/operations', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-device/platform-apple/runner/operations')>();
  return { ...actual, runAppleRunnerCommand: vi.fn(async () => ({})) };
});

// The real implementation shells out to simctl to probe for a hint-worthy
// unambiguous environment; that live-probe logic is covered by
// ios-app-session-hint.test.ts. Stubbed here so this suite stays hermetic and
// fast — defaults to "no enrichment", matching the current-behavior fallback.
vi.mock('../../../core/ios-app-session-hint.ts', () => ({
  buildIosOpenCommandHint: vi.fn(async () => undefined),
}));

import { runAppleRunnerCommand } from '@agent-device/platform-apple/runner/operations';
import { buildIosOpenCommandHint } from '../../../core/ios-app-session-hint.ts';

const mockRunnerCommand = vi.mocked(runAppleRunnerCommand);
const mockBuildIosOpenCommandHint = vi.mocked(buildIosOpenCommandHint);

function handleSnapshotCommands(
  params: Parameters<typeof handleProductionSnapshotCommands>[0],
): ReturnType<typeof handleProductionSnapshotCommands> {
  const runtime = snapshotRuntimeFixture(params.req.meta?.requestId);
  return handleProductionSnapshotCommands({
    ...params,
    inspectFacts: params.inspectFacts ?? runtime.inspectFacts,
    bindDevice: params.bindDevice ?? runtime.bindDevice,
    platformResourceCleanup: params.platformResourceCleanup ?? platformResourceCleanupFixture(),
  });
}

afterEach(() => {
  providerAdmission.setActive([]);
});

beforeEach(() => {
  resetSnapshotRuntimeFixture();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  mockRunnerCommand.mockReset();
  mockRunnerCommand.mockResolvedValue({});
  mockBuildIosOpenCommandHint.mockReset();
  mockBuildIosOpenCommandHint.mockResolvedValue(undefined);
});

test('settings rejects unsupported iOS physical devices', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'ios-device-1',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
  );

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', { positionals: ['wifi', 'on'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toBe('settings wifi is not supported on this device');
  }
});

test('settings clear-app-state dispatches explicit app id without an active app session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-clear-state';
  sessionStore.publish(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['clear-app-state', 'org.reactnavigation.playground'],
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(fixtureSettingsMutations.at(-1)).toMatchObject({
    setting: 'clear-app-state',
    state: 'clear',
    appBundleId: 'org.reactnavigation.playground',
  });
});

test('settings clear-app-state rejects missing app id when no app session is bound', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-clear-state-missing-app';
  sessionStore.publish(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', { positionals: ['clear-app-state'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/requires an app id/i);
    expect(response.error.details?.reason).toBe(PRE_DISPATCH_REFUSAL_REASONS.sessionAppRequired);
    expect(response.error.details?.dispatched).toBe('no');
  }
  expect(fixtureSettingsMutations).toHaveLength(0);
});

test('settings reset-keychain dispatches without an app id or active app session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-reset-keychain';
  sessionStore.publish(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['reset-keychain', 'clear'],
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(fixtureSettingsMutations.at(-1)).toMatchObject({
    setting: 'reset-keychain',
    state: 'clear',
  });
});

test('settings reset-keychain rejects an extra app argument instead of dropping it', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-reset-keychain-extra-arg';
  sessionStore.publish(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['reset-keychain', 'clear', 'com.example.app'],
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('INVALID_ARGS');
  }
  expect(fixtureSettingsMutations).toHaveLength(0);
});

test('settings text-size reads the category the owner holds without mutating anything', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-text-size-read';
  sessionStore.publish(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', { positionals: ['text-size'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(response?.ok && response.data).toMatchObject({
    setting: 'text-size',
    category: 'extra-extra-large',
    platformValue: 'extra-extra-large',
    message: 'Text size is extra-extra-large',
  });
  expect(fixtureSettingsReads).toMatchObject([{ setting: 'text-size' }]);
  expect(fixtureSettingsMutations).toHaveLength(0);
});

test('settings on the macOS host refuses a setting it does not serve, read and write alike', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-settings';
  const session = makeSession(sessionName, macOsDevice);
  activateCompleteRefFrame(session);
  sessionStore.publish(sessionName, session);

  for (const positionals of [['text-size'], ['text-size', 'large'], ['wifi', 'on']]) {
    const response = await handleSnapshotCommands({
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      req: snapshotRequest(sessionName, 'settings', { positionals }),
      sessionName,
      logPath: '/tmp/daemon.log',
      sessionStore,
    });
    expect(response?.ok).toBe(false);
    if (response && !response.ok) {
      expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
      expect(response.error.message).toBe(
        `settings ${positionals[0]} is not supported on this device`,
      );
      expect(response.error.details?.reason).toBe('unsupported-platform-leaf');
    }
  }
  expect(refFrameState(session)).toBe('active');
  expect(fixtureSettingsReads).toHaveLength(0);
  expect(fixtureSettingsMutations).toHaveLength(0);
});

test('settings text-size applies a ladder category through the write leg', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-text-size-write';
  const session = makeSession(sessionName, iosSimulatorDevice);
  activateCompleteRefFrame(session);
  sessionStore.publish(sessionName, session);

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['text-size', 'accessibility-extra-large'],
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(response?.ok && response.data).toMatchObject({
    setting: 'text-size',
    state: 'accessibility-extra-large',
    message: 'Text size set to accessibility-extra-large',
  });
  expect(fixtureSettingsMutations.at(-1)).toMatchObject({
    setting: 'text-size',
    state: 'accessibility-extra-large',
  });
  expect(fixtureSettingsReads).toHaveLength(0);
  // ADR 0014: the admitted mutation leg expires the frame it is about to invalidate.
  expect(refFrameState(session)).toBe('expired');
});

test('settings text-size refuses an Apple leaf with no content size before it expires the frame', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'tvos-text-size';
  const session = makeSession(sessionName, tvOsSimulatorDevice);
  activateCompleteRefFrame(session);
  sessionStore.publish(sessionName, session);

  for (const positionals of [['text-size'], ['text-size', 'large']]) {
    const response = await handleSnapshotCommands({
      createCommandSurface: fakeCreateCommandSurface,
      platformServices: daemonPlatformServicesFixture(),
      req: snapshotRequest(sessionName, 'settings', { positionals }),
      sessionName,
      logPath: '/tmp/daemon.log',
      sessionStore,
    });
    expect(response?.ok).toBe(false);
    if (response && !response.ok) {
      expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
      expect(response.error.message).toBe('settings text-size is not supported on this device');
    }
  }
  // Admission refuses before the write leg binds, so the frame survives.
  expect(refFrameState(session)).toBe('active');
  expect(fixtureSettingsReads).toHaveLength(0);
  expect(fixtureSettingsMutations).toHaveLength(0);
});

test('settings text-size refuses an off-ladder category with the whole ladder', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-text-size-invalid';
  sessionStore.publish(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', { positionals: ['text-size', 'gigantic'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/Invalid text-size state: gigantic/);
    expect(response.error.message).toMatch(/extra-small\|small\|medium\|large/);
    expect(response.error.message).toMatch(/accessibility-extra-extra-extra-large/);
  }
  // `simctl ui <device> content_size <bogus>` answers "Invalid argument" with exit 0, so a category
  // this gate let through would have been reported back as a change that changed nothing.
  expect(fixtureSettingsMutations).toHaveLength(0);
  expect(fixtureSettingsReads).toHaveLength(0);
});

test('settings usage hint documents canonical faceid states', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest('default', 'settings'),
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/appearance <light\|dark\|toggle>/);
    expect(response.error.message).toMatch(/match\|nonmatch\|enroll\|unenroll/);
    expect(response.error.message).toMatch(/grant\|deny\|reset/);
    expect(response.error.message).not.toMatch(/validate\|unvalidate/);
  }
});

// #3179: an app-scoped change can name an app the session never opened. The app rides the request
// input; the owner receives it as the resolved app id whether or not a session is bound.
test('settings permission grant targets an explicit app with no session app bound', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-permission-explicit-app';
  sessionStore.publish(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['permission', 'grant', 'camera'],
      input: { app: 'com.example.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(fixtureSettingsMutations.at(-1)).toMatchObject({
    setting: 'permission',
    state: 'grant',
    appBundleId: 'com.example.app',
    options: { permissionTarget: 'camera' },
  });
});

test('settings permission grant keeps the session app when no app is named', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-permission-session-app';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, iosSimulatorDevice, {
      appBundleId: 'com.session.app',
    }),
  );

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['permission', 'grant', 'camera'],
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(fixtureSettingsMutations.at(-1)).toMatchObject({ appBundleId: 'com.session.app' });
});

test('settings permission grant prefers an explicit app over the session app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-permission-explicit-over-session';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, iosSimulatorDevice, {
      appBundleId: 'com.session.app',
    }),
  );

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['permission', 'grant', 'camera'],
      input: { app: 'com.other.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(fixtureSettingsMutations.at(-1)).toMatchObject({ appBundleId: 'com.other.app' });
});

test('settings location on targets an explicit app on an iOS simulator', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-location-explicit-app';
  sessionStore.publish(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['location', 'on'],
      input: { app: 'com.example.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(fixtureSettingsMutations.at(-1)).toMatchObject({
    setting: 'location',
    state: 'on',
    appBundleId: 'com.example.app',
  });
});

test('settings Android permission grant targets an explicit app with no session app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-permission-explicit-app';
  sessionStore.publish(sessionName, makeSession(sessionName, androidDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['permission', 'grant', 'camera'],
      input: { app: 'com.example.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(fixtureSettingsMutations.at(-1)).toMatchObject({
    setting: 'permission',
    state: 'grant',
    appBundleId: 'com.example.app',
  });
});

// Android's on/off location writes the device-wide location_mode, so a named app names nothing it
// can grant: the refusal lands before the owner is reached and before the session ref frame is spent.
test('settings Android location on refuses a named app before reaching the owner', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-location-app-refused';
  sessionStore.publish(sessionName, makeSession(sessionName, androidDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['location', 'on'],
      input: { app: 'com.example.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  expect(fixtureSettingsMutations).toHaveLength(0);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/location on applies to the target itself/);
    expect(response.error.details?.reason).toBe('setting_app_not_consumed');
    expect(response.error.details?.dispatched).toBe('no');
  }
});

// A boolean alias is the same toggle to the owner's parser, so it must carry the app the same way:
// classifying `1` as unknown used to grant location to the session app while reporting success.
test('settings iOS location 1 targets an explicit app over the session app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-location-alias-explicit-app';
  sessionStore.publish(
    sessionName,
    makeSession(sessionName, iosSimulatorDevice, {
      appBundleId: 'com.session.app',
    }),
  );

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['location', '1'],
      input: { app: 'com.example.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(fixtureSettingsMutations.at(-1)).toMatchObject({
    setting: 'location',
    state: 'on',
    appBundleId: 'com.example.app',
  });
});

test('settings Android location true refuses a named app before reaching the owner', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-location-alias-refused';
  sessionStore.publish(sessionName, makeSession(sessionName, androidDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['location', 'true'],
      input: { app: 'com.example.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  expect(fixtureSettingsMutations).toHaveLength(0);
  if (response && !response.ok) {
    expect(response.error.details?.reason).toBe('setting_app_not_consumed');
    expect(response.error.details?.app).toBe('com.example.app');
  }
});

test('settings Android location 0 refuses a named app before reaching the owner', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-location-zero-refused';
  sessionStore.publish(sessionName, makeSession(sessionName, androidDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['location', '0'],
      input: { app: 'com.example.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  expect(fixtureSettingsMutations).toHaveLength(0);
  if (response && !response.ok) {
    expect(response.error.details?.reason).toBe('setting_app_not_consumed');
  }
});

// `location set` moves the device's own location for every family, so a named app contradicts the
// mutation everywhere. The writer forwards it (r4176656835) and this refusal answers it; the
// coordinates stay unparsed because the request must never reach the owner.
test('settings iOS location set refuses a named app before reaching the owner', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-location-set-refused';
  sessionStore.publish(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['location', 'set', '37.7', '-122.4'],
      input: { app: 'com.example.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  expect(fixtureSettingsMutations).toHaveLength(0);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/location set applies to the target itself/);
    expect(response.error.details?.reason).toBe('setting_app_not_consumed');
    expect(response.error.details?.dispatched).toBe('no');
  }
});

// A macOS permission is a host-level TCC grant, so naming an app is refused rather than dropped.
test('settings mobile-data reaches the Android owner as an on/off mutation', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-mobile-data';
  sessionStore.publish(sessionName, makeSession(sessionName, androidDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', { positionals: ['mobile-data', 'off'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(fixtureSettingsMutations.at(-1)).toMatchObject({ setting: 'mobile-data', state: 'off' });
});

test('settings Android mobile-data refuses a named app before reaching the owner', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-mobile-data-app-refused';
  sessionStore.publish(sessionName, makeSession(sessionName, androidDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['mobile-data', 'off'],
      input: { app: 'com.example.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  expect(fixtureSettingsMutations).toHaveLength(0);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.details?.reason).toBe('setting_app_not_consumed');
    expect(response.error.details?.dispatched).toBe('no');
  }
});

test('settings macOS permission grant refuses a named app before reaching the owner', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-permission-app-refused';
  sessionStore.publish(sessionName, makeSession(sessionName, macOsDevice));

  const response = await handleSnapshotCommands({
    createCommandSurface: fakeCreateCommandSurface,
    platformServices: daemonPlatformServicesFixture(),
    req: snapshotRequest(sessionName, 'settings', {
      positionals: ['permission', 'grant', 'screen-recording'],
      input: { app: 'com.example.app' },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  expect(fixtureSettingsMutations).toHaveLength(0);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.details?.reason).toBe('setting_app_not_consumed');
  }
});
