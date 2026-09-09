import { test, expect, vi, afterEach, beforeEach } from 'vitest';
import { legacyDispatchCapture } from '../../__tests__/legacy-snapshot-capture-fixture.ts';
import { resetGetRuntimeFixture } from '../../__tests__/interaction-get-runtime-fixture.ts';
import fs from 'node:fs';
import { captureSnapshot } from '../../snapshot-capture.ts';
import { SessionStore } from '../../session-store.ts';
import { setActiveProviderDeviceRuntimes } from '../../../provider-device-runtime.ts';
import { AppError } from '@agent-device/kernel/errors';
import { buildInteractionSurfaceSignature } from '../../interaction-outcome-policy.ts';
import { buildSnapshotPresentationKey } from '@agent-device/kernel/snapshot';
import { snapshotCliOutput } from '../../../commands/capture/output.ts';
import type { CaptureSnapshotResult } from '@agent-device/contracts/client';
import { buildNodes } from '../../../__tests__/test-utils/snapshot-builders.ts';
import {
  fixtureScreenshotCaptures,
  resetSnapshotRuntimeFixture,
} from '../../__tests__/snapshot-runtime-fixture.ts';
import {
  androidCapture,
  androidDevice,
  androidTextRows,
  handleSnapshotCommands,
  inboxBaselineNodes,
  inboxRow,
  iosSimulatorDevice,
  makeAndroidFreshnessSession,
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

function makeAndroidTimeoutEvidenceSession(sessionName: string): SessionStore {
  const sessionStore = makeSessionStore();
  const session = makeSession(sessionName, androidDevice);
  session.snapshot = {
    nodes: [
      {
        ref: 'e1',
        index: 0,
        depth: 0,
        type: 'android.widget.Button',
        label: 'Continue',
        hittable: true,
        rect: { x: 20, y: 40, width: 120, height: 48 },
      },
    ],
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);
  return sessionStore;
}

function mockAndroidTimeoutEvidenceDispatch(): void {
  legacyDispatchCapture.mockImplementation(async (_device, command) => {
    if (command === 'snapshot') throw androidSnapshotTimeoutError();
    return {};
  });
}

function androidSnapshotTimeoutError(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Android snapshot helper timed out while waiting for the UI to become idle.',
    {
      cmd: 'adb',
      args: ['shell', 'am', 'instrument'],
      androidCaptureFailureReason: 'accessibility-timeout',
      hint: 'Android accessibility snapshots can be blocked by busy or continuously changing app UI. Use screenshot as visual truth after this timeout.',
    },
  );
}

function expectAndroidTimeoutEvidence(
  response: Awaited<ReturnType<typeof handleSnapshotCommands>>,
) {
  if (!response) throw new Error('Expected snapshot response');
  if (response.ok) throw new Error('Expected snapshot timeout failure');
  expect(response.error.message).toMatch(/snapshot helper timed out/i);
  expect(response.error.hint).toMatch(/Use screenshot as visual truth/i);
  assertAndroidTimeoutEvidencePayload(response.error.details?.androidSnapshotTimeoutScreenshot);
}

function assertAndroidTimeoutEvidencePayload(evidence: unknown) {
  if (!evidence || typeof evidence !== 'object') {
    throw new Error('Expected Android snapshot timeout screenshot evidence');
  }
  const record = evidence as Record<string, unknown>;
  expect(record.path).toEqual(expect.stringContaining('snapshot-timeout-overlay-refs.png'));
  expect(fs.existsSync(record.path as string)).toBe(true);
  expect(record.overlayRefsAnnotated).toBe(true);
  expect(record.overlayRefs).toEqual([expect.objectContaining({ ref: 'e1', label: 'Continue' })]);
}

test('snapshot annotations survive pending interaction capture into CLI JSON', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-interaction-annotation-bundle';
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.Button',
      label: 'Open albums',
      hittable: true,
      rect: { x: 20, y: 120, width: 160, height: 48 },
    },
  ];
  const changedNodes = [
    {
      index: 0,
      depth: 0,
      type: 'android.widget.TextView',
      label: 'Albums',
      rect: { x: 32, y: 240, width: 180, height: 52 },
    },
  ];
  const snapshotQuality = { state: 'healthy', backend: 'tree' };
  session.pendingInteractionOutcome = {
    action: 'click',
    command: 'press',
    positionals: ['100', '144'],
    flags: { platform: 'android' },
    markedAt: Date.now(),
    attemptsRemaining: 2,
    preSignature: buildInteractionSurfaceSignature(baselineNodes),
  };
  sessionStore.set(sessionName, session);

  legacyDispatchCapture.mockResolvedValue({
    nodes: changedNodes,
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 1, maxDepth: 0 },
    quality: snapshotQuality,
    warnings: ['backend warning from interaction capture'],
  });

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot'),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;

  expect(response.data?.snapshotQuality).toEqual(snapshotQuality);
  expect(response.data?.warnings).toEqual(['backend warning from interaction capture']);

  const cliOutput = await snapshotCliOutput({
    result: response.data as unknown as CaptureSnapshotResult,
  });
  expect(cliOutput.jsonData).toMatchObject({
    nodes: [expect.objectContaining({ label: 'Albums' })],
    truncated: false,
    snapshotQuality,
    warnings: ['backend warning from interaction capture'],
  });
  expect(cliOutput.jsonData).not.toHaveProperty('analysis');
  expect(cliOutput.jsonData).not.toHaveProperty('freshness');
});

test('snapshot timeout captures Android screenshot evidence with overlay refs', async () => {
  const sessionName = 'android-timeout-evidence';
  const sessionStore = makeAndroidTimeoutEvidenceSession(sessionName);
  mockAndroidTimeoutEvidenceDispatch();
  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot'),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });
  expectAndroidTimeoutEvidence(response);
  expect(legacyDispatchCapture.mock.calls.map((call) => call[1])).toEqual(['snapshot']);
  expect(fixtureScreenshotCaptures.at(-1)?.options).toMatchObject({ stabilize: false });
});

test('snapshot warns when recent snapshot node count collapses sharply', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-stale-collapse';
  const session = makeSession(sessionName, androidDevice);
  session.snapshot = {
    nodes: buildNodes(androidTextRows(50, (row) => `Row ${row}`)),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  legacyDispatchCapture.mockResolvedValue(
    androidCapture(
      androidTextRows(8, (row) => `Next ${row}`),
      { rawNodeCount: 8, maxDepth: 1 },
    ),
  );

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot'),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warnings).toEqual([
      expect.stringContaining('Recent snapshots dropped sharply in node count'),
    ]);
  }
});

test('snapshot does not warn on expected node drop across presentation modes', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-presentation-drop';
  const session = makeSession(sessionName, iosSimulatorDevice);
  session.appBundleId = 'com.example.app';
  session.snapshot = {
    nodes: Array.from({ length: 50 }, (_, index) => ({
      ref: `e${index + 1}`,
      index,
      depth: 0,
      type: 'StaticText',
      label: `Row ${index + 1}`,
    })),
    createdAt: Date.now(),
    backend: 'xctest',
    presentationKey: buildSnapshotPresentationKey({ interactiveOnly: false }),
  };
  sessionStore.set(sessionName, session);

  legacyDispatchCapture.mockResolvedValue({
    nodes: Array.from({ length: 8 }, (_, index) => ({
      index,
      depth: 0,
      type: 'Button',
      label: `Action ${index + 1}`,
      hittable: true,
    })),
    truncated: false,
    backend: 'xctest',
  });

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot', { flags: { snapshotInteractiveOnly: true } }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warnings ?? []).toEqual(
      expect.not.arrayContaining([
        expect.stringContaining('Recent snapshots dropped sharply in node count'),
      ]),
    );
  }
});

test('snapshot automatically retries stale Android trees after recent navigation', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-stale-retries-to-fresh';
  const session = makeAndroidFreshnessSession(sessionName, 'press', inboxBaselineNodes(24));
  sessionStore.set(sessionName, session);

  legacyDispatchCapture
    .mockResolvedValueOnce(
      androidCapture(androidTextRows(24, inboxRow), { rawNodeCount: 24, maxDepth: 2 }),
    )
    .mockResolvedValueOnce(
      androidCapture(
        [
          { index: 0, depth: 0, type: 'android.widget.TextView', label: 'Create document' },
          { index: 1, depth: 0, type: 'android.widget.Button', label: 'Submit', hittable: true },
        ],
        { rawNodeCount: 2, maxDepth: 1 },
      ),
    );

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot', { flags: { snapshotInteractiveOnly: true } }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warnings).toBeUndefined();
    expect(response.data?.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Create document' })]),
    );
  }
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(2);
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toBeUndefined();
});

test('snapshot warns when Android freshness retries still return the previous route', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-stale-after-press';
  const session = makeAndroidFreshnessSession(sessionName, 'press', inboxBaselineNodes(24));
  sessionStore.set(sessionName, session);

  legacyDispatchCapture.mockResolvedValue(
    androidCapture(androidTextRows(24, inboxRow), { rawNodeCount: 24, maxDepth: 2 }),
  );

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot', { flags: { snapshotInteractiveOnly: true } }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warnings).toEqual([
      expect.stringContaining(
        'Recent press was followed by a nearly identical snapshot after 3 automatic retries',
      ),
    ]);
  }
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(4);
});

test('snapshot response includes normalized visibility metadata', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-visibility';
  sessionStore.set(sessionName, makeSession(sessionName, androidDevice));

  legacyDispatchCapture.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'android.widget.ScrollView',
        label: 'Messages',
        rect: { x: 0, y: 100, width: 390, height: 500 },
        hiddenContentBelow: true,
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'android.widget.Button',
        label: 'Visible message',
        rect: { x: 0, y: 140, width: 390, height: 48 },
        hittable: true,
      },
    ],
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 2, maxDepth: 1 },
  });

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'snapshot', { flags: { snapshotInteractiveOnly: true } }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.visibility).toEqual({
      partial: true,
      visibleNodeCount: 2,
      totalNodeCount: 2,
      reasons: ['scroll-hidden-below'],
    });
  }
});

test('diff snapshot carries stale-tree warnings for recent Android presses', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-diff-stale-after-press';
  const session = makeAndroidFreshnessSession(sessionName, 'press', inboxBaselineNodes(24));
  sessionStore.set(sessionName, session);

  legacyDispatchCapture.mockResolvedValue(
    androidCapture(androidTextRows(24, inboxRow), { rawNodeCount: 24, maxDepth: 2 }),
  );

  const response = await handleSnapshotCommands({
    req: snapshotRequest(sessionName, 'diff', {
      positionals: ['snapshot'],
      flags: { snapshotInteractiveOnly: true },
    }),
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.warnings).toEqual([
      expect.stringContaining(
        'Recent press was followed by a nearly identical snapshot after 3 automatic retries',
      ),
    ]);
  }
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(4);
});

test('Android ref refresh mode does not retry narrow snapshots as sharp drops', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-ref-refresh-no-sharp-drop';
  const session = makeAndroidFreshnessSession(
    sessionName,
    'press',
    buildNodes(androidTextRows(50, (row) => `Previous row ${row}`)),
  );
  sessionStore.set(sessionName, session);

  legacyDispatchCapture.mockResolvedValue(
    androidCapture(
      Array.from({ length: 8 }, (_, index) => ({
        index,
        depth: 0,
        type: 'android.widget.TextView',
      })),
      { rawNodeCount: 8, maxDepth: 1 },
    ),
  );

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
    androidFreshnessMode: 'ref-refresh',
  });

  expect(result.freshness).toBeUndefined();
  expect(legacyDispatchCapture).toHaveBeenCalledTimes(1);
  expect(session.androidSnapshotFreshness).toBeUndefined();
});
