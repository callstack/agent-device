import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { handleSnapshotCommands as handleProductionSnapshotCommands } from '../snapshot.ts';
import {
  isActiveProviderDevice,
  setActiveProviderDeviceRuntimes,
} from '../../../provider-device-runtime.ts';
import { installProviderDeviceAdmission } from '../../provider-device-admission.ts';

// The daemon reads provider ownership through its own typed admission seam; production
// installs it from root composition, and these tests compose it the same way.
installProviderDeviceAdmission({ isActive: isActiveProviderDevice });
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import {
  fixtureSettingsMutations,
  fixtureSettingsReads,
  resetSnapshotRuntimeFixture,
  snapshotRuntimeFixture,
} from '../../__tests__/snapshot-runtime-fixture.ts';
import {
  iosSimulatorDevice,
  macOsDevice,
  makeSession,
  makeSessionStore,
  snapshotRequest,
} from './snapshot-handler.fixtures.ts';

vi.mock('../../snapshot-interactor-capture.ts', async () => {
  const fixture = await import('../../__tests__/legacy-snapshot-capture-fixture.ts');
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
vi.mock('../../ios-app-session-hint.ts', () => ({
  buildIosOpenCommandHint: vi.fn(async () => undefined),
}));

import { runAppleRunnerCommand } from '@agent-device/platform-apple/runner/operations';
import { buildIosOpenCommandHint } from '../../ios-app-session-hint.ts';

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
    platformResourceCleanup: params.platformResourceCleanup ?? platformResourceCleanup,
  });
}

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
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
  sessionStore.set(
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
    req: snapshotRequest(sessionName, 'settings', { positionals: ['wifi', 'on'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/settings is not supported/i);
  }
});

test('settings clear-app-state dispatches explicit app id without an active app session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-clear-state';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
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
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'settings', { positionals: ['clear-app-state'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/requires an app id/i);
  }
  expect(fixtureSettingsMutations).toHaveLength(0);
});

test('settings reset-keychain dispatches without an app id or active app session', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-reset-keychain';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
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
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
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
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
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

test('settings text-size refuses the macOS host, which serves no content size to read', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-text-size-read';
  sessionStore.set(sessionName, makeSession(sessionName, macOsDevice));

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'settings', { positionals: ['text-size'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('UNSUPPORTED_OPERATION');
    expect(response.error.message).toMatch(/text-size is not supported/i);
  }
  expect(fixtureSettingsReads).toHaveLength(0);
  expect(fixtureSettingsMutations).toHaveLength(0);
});

test('settings text-size applies a ladder category through the write leg', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-text-size-write';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
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
});

test('settings text-size refuses an off-ladder category with the whole ladder', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-text-size-invalid';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'settings', { positionals: ['text-size', 'gigantic'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/Invalid text size: gigantic/);
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

test('settings on macOS rejects wifi before dispatch with explicit subset guidance', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-settings-wifi';
  sessionStore.set(sessionName, makeSession(sessionName, macOsDevice));

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'settings', { positionals: ['wifi', 'on'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(fixtureSettingsMutations).toHaveLength(0);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/Unsupported macOS setting: wifi/i);
    expect(response.error.message).toMatch(/appearance <light\|dark\|toggle>/);
    expect(response.error.message).toMatch(
      /permission <grant\|reset> <accessibility\|screen-recording\|input-monitoring>/,
    );
    expect(response.error.message).toMatch(
      /wifi\|airplane\|location\|animations\|text-size remain unsupported on macOS/i,
    );
  }
});
