import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { handleSnapshotCommands as handleProductionSnapshotCommands } from '../snapshot.ts';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import { platformResourceCleanup } from '../../../platform-runtime-resource-cleanup.ts';
import {
  fixtureSettingsMutations,
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
      /wifi\|airplane\|location\|animations remain unsupported on macOS/i,
    );
  }
});
