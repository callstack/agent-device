import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { resetGetRuntimeFixture } from '../../__tests__/interaction-get-runtime-fixture.ts';
import { resetSnapshotRuntimeFixture } from '../../__tests__/snapshot-runtime-fixture.ts';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import type { DaemonResponse } from '../../daemon-request.ts';
import type { SessionState } from '../../session-state.ts';
import {
  androidCapture,
  androidDevice,
  countingSnapshotRuntime,
  handleSnapshotCommands,
  iosSimulatorDevice,
  makeProviderRuntimeOwning,
  makeSession,
  makeSessionStore,
  providerIosDevice,
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
import { expireRefFrame, refFrame, refFrameState, refFrameTree } from '../../ref-frame.ts';

const mockRunnerCommand = vi.mocked(runAppleRunnerCommand);
const mockBuildIosOpenCommandHint = vi.mocked(buildIosOpenCommandHint);

afterEach(() => {
  setActiveProviderDeviceRuntimes([]);
});

beforeEach(() => {
  resetSnapshotRuntimeFixture();
  legacyDispatchCapture.mockReset();
  legacyDispatchCapture.mockResolvedValue({});
  resetGetRuntimeFixture();
  mockRunnerCommand.mockReset();
  mockRunnerCommand.mockResolvedValue({});
  mockBuildIosOpenCommandHint.mockReset();
  mockBuildIosOpenCommandHint.mockResolvedValue(undefined);
});

test('snapshot rejects @ref scope without existing session snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'apple',
      id: 'sim-1',
      name: 'My iPhone Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot', { flags: { snapshotScope: '@e1' } }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/requires an existing snapshot/i);
  }
});

test('snapshot on iOS rejects sessions without a tracked app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-no-app';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));
  const runtime = countingSnapshotRuntime();

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot'),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/iOS snapshot requires an active app session/i);
    expect(response.error.details?.reason).toBe('ios_app_session_required');
    expect(response.error.details?.hint).toBeUndefined();
  }
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
  expect(runtime.bindCount()).toBe(0);
});

test('snapshot on iOS without a tracked app carries the detected open command as its hint', async () => {
  mockBuildIosOpenCommandHint.mockResolvedValue(
    'One booted device found ("My iPhone Simulator", udid sim-1) with xyz.blueskyweb.app ' +
      'running. Run: agent-device open xyz.blueskyweb.app --platform ios --udid sim-1',
  );
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-no-app-hinted';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot'),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.details?.hint).toBe(
      'One booted device found ("My iPhone Simulator", udid sim-1) with xyz.blueskyweb.app ' +
        'running. Run: agent-device open xyz.blueskyweb.app --platform ios --udid sim-1',
    );
  }
  expect(mockBuildIosOpenCommandHint).toHaveBeenCalledWith(iosSimulatorDevice);
});

// #1658: the app-session requirement is the local XCUITest runner's, not the
// capture's. A cloud device reads its page source through the provider's own
// driver session, and its open path cannot resolve a bundle id locally, so the
// guard refused every capture on a live, healthy session.
test('snapshot on provider-backed iOS runs without a tracked app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-cloud-no-app';
  sessionStore.set(sessionName, makeSession(sessionName, providerIosDevice));
  setActiveProviderDeviceRuntimes([makeProviderRuntimeOwning(providerIosDevice)]);
  legacyDispatchCapture.mockResolvedValue({
    nodes: [{ index: 0, depth: 0, type: 'XCUIElementTypeButton', label: 'Sign in' }],
    truncated: false,
    backend: 'xctest',
  });
  const runtime = countingSnapshotRuntime();

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot'),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
    inspectFacts: runtime.inspectFacts,
    bindDevice: runtime.bindDevice,
  });

  expect(response?.ok).toBe(true);
  expect(legacyDispatchCapture).toHaveBeenCalled();
  // The bypass has to happen before the hint probe (#1662), which shells out to
  // simctl and can only ever see local simulators — for a hosted device it is a
  // guaranteed-useless spawn on what is now a success path.
  expect(mockBuildIosOpenCommandHint).not.toHaveBeenCalled();
  expect(runtime.bindCount()).toBe(1);
});

test('diff on local iOS still requires a tracked app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-no-app-diff';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'diff', { positionals: ['snapshot'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/iOS diff requires an active app session/i);
  }
  expect(legacyDispatchCapture).not.toHaveBeenCalled();
});

test('snapshot on iOS runs when the session tracks an app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-app';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, iosSimulatorDevice),
    appBundleId: 'org.reactnavigation.playground',
  });
  legacyDispatchCapture.mockResolvedValue({
    nodes: [{ index: 0, depth: 0, type: 'Button', label: 'Home' }],
    truncated: false,
    backend: 'ios',
  });

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot'),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(legacyDispatchCapture).toHaveBeenCalledWith(
    iosSimulatorDevice,
    'snapshot',
    [],
    undefined,
    expect.objectContaining({ appBundleId: 'org.reactnavigation.playground' }),
  );
});

test('snapshot re-activates a complete frame; diff preserves it (ADR 0014)', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-stale-refs-marker';
  const session = makeSession(sessionName, androidDevice);
  session.snapshot = {
    nodes: [{ ref: 'e1', index: 0, depth: 0, type: 'android.widget.Button', label: 'Old' }],
    createdAt: Date.now(),
    backend: 'android',
  };
  // A prior device action expired the frame.
  expireRefFrame(session);
  sessionStore.set(sessionName, session);
  legacyDispatchCapture.mockResolvedValue({
    nodes: [{ index: 0, depth: 0, type: 'android.widget.Button', label: 'Fresh' }],
    truncated: false,
    backend: 'android',
  });

  const snapshotResponse = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot'),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  // The snapshot response hands every stored node's ref to the client: it
  // re-activates a complete frame, so refs are current again.
  expect(snapshotResponse?.ok).toBe(true);
  expect(refFrameState(sessionStore.get(sessionName)!)).toBe('active');

  const diffResponse = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'diff', { positionals: ['snapshot'] }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  // diff replaces the observation but is a read (summary response): it preserves
  // the authorized frame rather than expiring it.
  expect(diffResponse?.ok).toBe(true);
  expect(refFrameState(sessionStore.get(sessionName)!)).toBe('active');
});

// #1076 versioned refs — shared harness for the refsGeneration tests below.
async function runVersionedRefsCommand(params: {
  sessionStore: ReturnType<typeof makeSessionStore>;
  sessionName: string;
  command: 'snapshot' | 'diff';
}): Promise<Record<string, unknown> | undefined> {
  const response = await handleSnapshotCommands({
    req: snapshotRequest(params.sessionName, params.command, {
      positionals: params.command === 'diff' ? ['snapshot'] : [],
    }),
    sessionName: params.sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore: params.sessionStore,
  });
  expect(response?.ok).toBe(true);
  return response?.ok ? response.data : undefined;
}

function makeVersionedRefsScenario(sessionName: string) {
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName, androidDevice));
  legacyDispatchCapture.mockResolvedValue({
    nodes: [{ index: 0, depth: 0, type: 'android.widget.Button', label: 'Fresh' }],
    truncated: false,
    backend: 'android',
  });
  return sessionStore;
}

function expectInternalObservationResult(params: {
  response: DaemonResponse | null | undefined;
  session: SessionState | undefined;
  publishedGeneration: number | undefined;
  publishedTree: SessionState['snapshot'];
}): void {
  expect(params.response?.ok).toBe(true);
  expect(params.response?.ok ? params.response.data?.refsGeneration : undefined).toBeUndefined();
  expect(params.session?.snapshotGeneration).toBe((params.publishedGeneration as number) + 1);
  expect(params.session?.snapshot).not.toBe(params.publishedTree);
  expect(refFrame(params.session!).generation).toBe(params.publishedGeneration);
  expect(refFrameTree(params.session!)).toBe(params.publishedTree);
}

test('snapshot responses carry refsGeneration and advance it per capture (#1076 versioned refs)', async () => {
  const sessionName = 'android-refs-generation';
  const sessionStore = makeVersionedRefsScenario(sessionName);

  const first = await runVersionedRefsCommand({ sessionStore, sessionName, command: 'snapshot' });
  // Ref-issuing response reports the generation ONCE; the node tree itself
  // stays plain `e1` refs (token economy). The first generation of a session
  // lifetime is SEEDED (random 6-digit base), so assert relative bumps and
  // echo the observed seed instead of literals.
  const seed = first?.refsGeneration;
  expect(typeof seed).toBe('number');
  expect(sessionStore.get(sessionName)?.snapshotGeneration).toBe(seed);

  const second = await runVersionedRefsCommand({ sessionStore, sessionName, command: 'snapshot' });
  expect(second?.refsGeneration).toBe((seed as number) + 1);
});

test('diff advances the generation without issuing refsGeneration (#1076 versioned refs)', async () => {
  const sessionName = 'android-refs-generation-diff';
  const sessionStore = makeVersionedRefsScenario(sessionName);

  await runVersionedRefsCommand({ sessionStore, sessionName, command: 'snapshot' });

  const seed = sessionStore.get(sessionName)?.snapshotGeneration as number;

  // diff replaces the stored tree too — the generation advances even though
  // the summary response issues no refs, which is exactly what a ref pinned
  // to the snapshot generation would then warn about.
  const diffData = await runVersionedRefsCommand({ sessionStore, sessionName, command: 'diff' });
  expect(diffData?.refsGeneration).toBeUndefined();
  expect(sessionStore.get(sessionName)?.snapshotGeneration).toBe(seed + 1);
});

test('daemon-private snapshot observation advances capture state without publishing ref authority', async () => {
  const sessionName = 'android-internal-observation';
  const sessionStore = makeVersionedRefsScenario(sessionName);

  await runVersionedRefsCommand({ sessionStore, sessionName, command: 'snapshot' });
  const published = sessionStore.get(sessionName);
  const publishedGeneration = refFrame(published!).generation;
  const publishedTree = refFrameTree(published!);

  legacyDispatchCapture.mockResolvedValue({
    nodes: [{ index: 0, depth: 0, type: 'android.widget.Button', label: 'Internal' }],
    truncated: false,
    backend: 'android',
  });

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot', { internal: { observationOnly: true } }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expectInternalObservationResult({
    response,
    session: sessionStore.get(sessionName),
    publishedGeneration,
    publishedTree,
  });
});

test('snapshot surfaces filtered-to-zero Android guidance for interactive snapshots', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-empty-interactive';
  sessionStore.set(sessionName, makeSession(sessionName, androidDevice));

  legacyDispatchCapture.mockResolvedValue(androidCapture([], { rawNodeCount: 42, maxDepth: 8 }));

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot', {
      flags: { snapshotInteractiveOnly: true, snapshotDepth: 3 },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warnings).toEqual([
      expect.stringContaining('Interactive snapshot is empty after filtering 42 raw Android nodes'),
      'Interactive output is empty at depth 3; retry without -d.',
    ]);
  }
});

test('diff rejects unsupported kind', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSnapshotCommands({
    req: snapshotRequest('default', 'diff', { positionals: ['unknown'] }),
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/diff.*supports.*snapshot/i);
  }
});

test('diff screenshot is not handled daemon-side (client-backed command)', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSnapshotCommands({
    req: snapshotRequest('default', 'diff', { positionals: ['screenshot'] }),
    sessionName: 'default',
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/diff.*supports.*snapshot/i);
  }
});
