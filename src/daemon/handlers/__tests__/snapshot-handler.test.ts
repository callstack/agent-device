import { test, expect, vi, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PNG } from '../../../utils/png.ts';
import { handleSnapshotCommands } from '../snapshot.ts';
import { withSessionlessRunnerCleanup } from '../snapshot-session.ts';
import { captureSnapshot } from '../snapshot-capture.ts';
import { SessionStore } from '../../session-store.ts';
import type { SessionState } from '../../types.ts';
import { AppError } from '../../../kernel/errors.ts';
import { buildSnapshotSignatures } from '../../android-snapshot-freshness.ts';
import { buildInteractionSurfaceSignature } from '../../interaction-outcome-policy.ts';
import { buildSnapshotPresentationKey } from '../../../kernel/snapshot.ts';
import { snapshotCliOutput } from '../../../commands/capture/output.ts';
import type { CaptureSnapshotResult } from '../../../client-types.ts';

vi.mock('../../../core/dispatch.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../core/dispatch.ts')>();
  return {
    ...actual,
    dispatchCommand: vi.fn(async () => ({})),
  };
});

vi.mock('../../../platforms/ios/runner-client.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platforms/ios/runner-client.ts')>();
  return {
    ...actual,
    runIosRunnerCommand: vi.fn(async () => ({})),
    stopIosRunnerSession: vi.fn(async () => {}),
  };
});

vi.mock('../../../platforms/ios/apps.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../platforms/ios/apps.ts')>();
  return {
    ...actual,
    closeIosApp: vi.fn(async () => {}),
  };
});

import { dispatchCommand } from '../../../core/dispatch.ts';
import { runIosRunnerCommand, stopIosRunnerSession } from '../../../platforms/ios/runner-client.ts';
import { closeIosApp } from '../../../platforms/ios/apps.ts';

const mockDispatch = vi.mocked(dispatchCommand);
const mockRunnerCommand = vi.mocked(runIosRunnerCommand);
const mockStopIosRunnerSession = vi.mocked(stopIosRunnerSession);
const mockCloseIosApp = vi.mocked(closeIosApp);

function makeSessionStore(): SessionStore {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-device-snapshot-handler-'));
  return new SessionStore(path.join(root, 'sessions'));
}

function makeSession(name: string, device: SessionState['device']): SessionState {
  return {
    name,
    device,
    createdAt: Date.now(),
    actions: [],
  };
}

const iosSimulatorDevice: SessionState['device'] = {
  platform: 'ios',
  id: 'sim-1',
  name: 'My iPhone Simulator',
  kind: 'simulator',
  booted: true,
};

const macOsDevice: SessionState['device'] = {
  platform: 'macos',
  id: 'host-macos-local',
  name: 'Host Mac',
  kind: 'device',
  target: 'desktop',
  booted: true,
};

const androidDevice: SessionState['device'] = {
  platform: 'android',
  id: 'emulator-5554',
  name: 'Pixel 9 Pro XL',
  kind: 'emulator',
  target: 'mobile',
  booted: true,
};

beforeEach(() => {
  mockDispatch.mockReset();
  mockDispatch.mockResolvedValue({});
  mockRunnerCommand.mockReset();
  mockRunnerCommand.mockResolvedValue({});
  mockStopIosRunnerSession.mockReset();
  mockStopIosRunnerSession.mockResolvedValue();
  mockCloseIosApp.mockReset();
  mockCloseIosApp.mockResolvedValue();
});

function writeSolidPng(filePath: string, width = 390, height = 844): void {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = 255;
    png.data[index + 1] = 255;
    png.data[index + 2] = 255;
    png.data[index + 3] = 255;
  }
  fs.writeFileSync(filePath, PNG.sync.write(png));
}

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
  mockDispatch.mockImplementation(async (_device, command, positionals, _out, context) => {
    if (command === 'snapshot') throw androidSnapshotTimeoutError();
    if (command === 'screenshot') {
      const screenshotPath = positionals[0]!;
      expect(context?.screenshotNoStabilize).toBe(true);
      writeSolidPng(screenshotPath);
      return { path: screenshotPath };
    }
    return {};
  });
}

function androidSnapshotTimeoutError(): AppError {
  return new AppError(
    'COMMAND_FAILED',
    'Android UI hierarchy dump timed out while waiting for the UI to become idle.',
    {
      cmd: 'adb',
      args: ['exec-out', 'uiautomator', 'dump', '/dev/tty'],
      timeoutMs: 8000,
      hint: 'Android accessibility snapshots can be blocked by busy or continuously changing app UI. Use screenshot as visual truth after this timeout.',
    },
  );
}

function expectAndroidTimeoutEvidence(
  response: Awaited<ReturnType<typeof handleSnapshotCommands>>,
) {
  if (!response) throw new Error('Expected snapshot response');
  if (response.ok) throw new Error('Expected snapshot timeout failure');
  expect(response.error.message).toMatch(/UI hierarchy dump timed out/i);
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
  expect(record.overlayRefCount).toBe(1);
  expect(record.overlayRefs).toEqual([expect.objectContaining({ ref: 'e1', label: 'Continue' })]);
}

async function runWaitCommand(
  sessionName: string,
  device: SessionState['device'],
  positionals: string[],
) {
  const sessionStore = makeSessionStore();
  sessionStore.set(sessionName, makeSession(sessionName, device));
  return await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals,
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });
}

const locationPermissionNodes = [
  {
    index: 0,
    depth: 0,
    type: 'android.widget.FrameLayout',
    label: 'Location permission',
    rect: { x: 0, y: 0, width: 390, height: 844 },
  },
  {
    index: 1,
    depth: 1,
    parentIndex: 0,
    type: 'android.widget.TextView',
    label: 'Allow location access?',
    rect: { x: 24, y: 210, width: 342, height: 40 },
  },
  {
    index: 2,
    depth: 1,
    parentIndex: 0,
    type: 'android.widget.Button',
    label: 'Not now',
    rect: { x: 24, y: 320, width: 140, height: 48 },
    hittable: true,
  },
  {
    index: 3,
    depth: 1,
    parentIndex: 0,
    type: 'android.widget.Button',
    label: 'Continue',
    rect: { x: 180, y: 320, width: 160, height: 48 },
    hittable: true,
  },
];

const locationRequiredNodes = [
  {
    index: 0,
    depth: 0,
    type: 'android.widget.TextView',
    label: 'Location required',
    rect: { x: 24, y: 180, width: 342, height: 40 },
  },
  {
    index: 1,
    depth: 0,
    type: 'android.widget.Button',
    label: 'Dismiss',
    rect: { x: 24, y: 260, width: 342, height: 48 },
  },
];

const iosSurfaceSummaryNodes = [
  {
    index: 0,
    depth: 0,
    type: 'XCUIElementTypeApplication',
    label: 'Expo Go',
    rect: { x: 0, y: 0, width: 393, height: 852 },
  },
  {
    index: 1,
    depth: 1,
    type: 'XCUIElementTypeImage',
    label: 'gearshape.fill',
    rect: { x: 12, y: 54, width: 24, height: 24 },
  },
  {
    index: 2,
    depth: 1,
    type: 'XCUIElementTypeOther',
    label: 'Tab Bar',
    rect: { x: 0, y: 760, width: 393, height: 92 },
  },
  {
    index: 3,
    depth: 1,
    type: 'XCUIElementTypeStaticText',
    label: 'Confirm catalog refresh',
    rect: { x: 48, y: 280, width: 297, height: 36 },
  },
  {
    index: 4,
    depth: 1,
    type: 'XCUIElementTypeButton',
    label: 'Keep browsing',
    rect: { x: 48, y: 360, width: 297, height: 48 },
  },
  {
    index: 5,
    depth: 1,
    type: 'XCUIElementTypeButton',
    identifier: 'host.exp.exponent:id/reload_button',
    rect: { x: 260, y: 54, width: 48, height: 48 },
  },
];

test('snapshot rejects @ref scope without existing session snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'ios',
      id: 'sim-1',
      name: 'My iPhone Simulator',
      kind: 'simulator',
      booted: true,
    }),
  );

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: { snapshotScope: '@e1' },
    },
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

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('SESSION_NOT_FOUND');
    expect(response.error.message).toMatch(/iOS snapshot requires an active app session/i);
  }
  expect(mockDispatch).not.toHaveBeenCalled();
});

test('snapshot on iOS runs when the session tracks an app', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim-app';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, iosSimulatorDevice),
    appBundleId: 'org.reactnavigation.playground',
  });
  mockDispatch.mockResolvedValue({
    nodes: [{ index: 0, depth: 0, type: 'Button', label: 'Home' }],
    truncated: false,
    backend: 'ios',
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledWith(
    iosSimulatorDevice,
    'snapshot',
    [],
    undefined,
    expect.objectContaining({ appBundleId: 'org.reactnavigation.playground' }),
  );
});

test('snapshot surfaces filtered-to-zero Android guidance for interactive snapshots', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-empty-interactive';
  sessionStore.set(sessionName, makeSession(sessionName, androidDevice));

  mockDispatch.mockResolvedValue({
    nodes: [],
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 42, maxDepth: 8 },
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: { snapshotInteractiveOnly: true, snapshotDepth: 3 },
    },
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

  mockDispatch.mockResolvedValue({
    nodes: changedNodes,
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 1, maxDepth: 0 },
    quality: snapshotQuality,
    warnings: ['backend warning from interaction capture'],
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (!response?.ok) return;

  expect(response.data?.snapshotQuality).toEqual(snapshotQuality);
  expect(response.data?.warnings).toEqual(['backend warning from interaction capture']);

  const cliOutput = snapshotCliOutput({
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
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });
  expectAndroidTimeoutEvidence(response);
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['snapshot', 'screenshot']);
});

test('snapshot warns when recent snapshot node count collapses sharply', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-stale-collapse';
  const session = makeSession(sessionName, androidDevice);
  session.snapshot = {
    nodes: Array.from({ length: 50 }, (_, index) => ({
      ref: `e${index + 1}`,
      index,
      depth: 0,
      type: 'android.widget.TextView',
      label: `Row ${index + 1}`,
    })),
    createdAt: Date.now(),
    backend: 'android',
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({
    nodes: Array.from({ length: 8 }, (_, index) => ({
      index,
      depth: 0,
      type: 'android.widget.TextView',
      label: `Next ${index + 1}`,
    })),
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 8, maxDepth: 1 },
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: {},
    },
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

  mockDispatch.mockResolvedValue({
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
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: { snapshotInteractiveOnly: true },
    },
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
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = Array.from({ length: 24 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  };
  sessionStore.set(sessionName, session);

  mockDispatch
    .mockResolvedValueOnce({
      nodes: Array.from({ length: 24 }, (_, index) => ({
        index,
        depth: 0,
        type: 'android.widget.TextView',
        label: `Inbox row ${index + 1}`,
      })),
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 24, maxDepth: 2 },
    })
    .mockResolvedValueOnce({
      nodes: [
        { index: 0, depth: 0, type: 'android.widget.TextView', label: 'Create document' },
        { index: 1, depth: 0, type: 'android.widget.Button', label: 'Submit', hittable: true },
      ],
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 2, maxDepth: 1 },
    });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: { snapshotInteractiveOnly: true },
    },
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
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  expect(sessionStore.get(sessionName)?.androidSnapshotFreshness).toBeUndefined();
});

test('snapshot warns when Android freshness retries still return the previous route', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-stale-after-press';
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = Array.from({ length: 24 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({
    nodes: Array.from({ length: 24 }, (_, index) => ({
      index,
      depth: 0,
      type: 'android.widget.TextView',
      label: `Inbox row ${index + 1}`,
    })),
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 24, maxDepth: 2 },
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: { snapshotInteractiveOnly: true },
    },
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
  expect(mockDispatch).toHaveBeenCalledTimes(4);
});

test('snapshot response includes normalized visibility metadata', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-visibility';
  sessionStore.set(sessionName, makeSession(sessionName, androidDevice));

  mockDispatch.mockResolvedValue({
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
    req: {
      token: 't',
      session: sessionName,
      command: 'snapshot',
      positionals: [],
      flags: { snapshotInteractiveOnly: true },
    },
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
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = Array.from({ length: 24 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({
    nodes: Array.from({ length: 24 }, (_, index) => ({
      index,
      depth: 0,
      type: 'android.widget.TextView',
      label: `Inbox row ${index + 1}`,
    })),
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 24, maxDepth: 2 },
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'diff',
      positionals: ['snapshot'],
      flags: { snapshotInteractiveOnly: true },
    },
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
  expect(mockDispatch).toHaveBeenCalledTimes(4);
});

test('Android ref refresh mode does not retry narrow snapshots as sharp drops', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-ref-refresh-no-sharp-drop';
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = Array.from({ length: 50 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Previous row ${index + 1}`,
  }));
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  };
  sessionStore.set(sessionName, session);

  mockDispatch.mockResolvedValue({
    nodes: Array.from({ length: 8 }, (_, index) => ({
      index,
      depth: 0,
      type: 'android.widget.TextView',
    })),
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 8, maxDepth: 1 },
  });

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
    androidFreshnessMode: 'ref-refresh',
  });

  expect(result.freshness).toBeUndefined();
  expect(mockDispatch).toHaveBeenCalledTimes(1);
  expect(session.androidSnapshotFreshness).toBeUndefined();
});

test('captureSnapshot lazily retries pending no-change touch before returning fresh state', async () => {
  const sessionName = 'ios-lazy-outcome-retry';
  const session = makeSession(sessionName, iosSimulatorDevice);
  const baselineNodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'Button',
      label: 'Open feed',
      identifier: 'open-feed',
      hittable: true,
      rect: { x: 20, y: 120, width: 160, height: 48 },
    },
  ];
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'xctest',
  };
  session.pendingInteractionOutcome = {
    action: 'click',
    command: 'press',
    positionals: ['100', '144'],
    flags: { platform: 'ios' },
    markedAt: Date.now(),
    attemptsRemaining: 2,
    preSignature: [
      {
        key: 'open-feed|Open feed||Button||enabled|unselected|hittable|#0',
        x: 20,
        y: 120,
        width: 160,
        height: 48,
      },
    ],
  };

  let pressed = false;
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      pressed = true;
      return { clicked: true };
    }
    return {
      nodes: !pressed
        ? baselineNodes
        : [
            {
              index: 0,
              depth: 0,
              type: 'Button',
              label: 'Back',
              identifier: 'back',
              hittable: true,
              rect: { x: 20, y: 60, width: 90, height: 44 },
            },
            {
              index: 1,
              depth: 0,
              type: 'StaticText',
              label: 'Feed',
              rect: { x: 20, y: 140, width: 160, height: 48 },
            },
          ],
      backend: 'xctest',
    };
  });

  const result = await captureSnapshot({
    device: iosSimulatorDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Feed' })]),
  );
  expect(
    mockDispatch.mock.calls.map((call) => call[1]).filter((command) => command === 'press'),
  ).toEqual(['press']);
  expect(mockDispatch.mock.calls.find((call) => call[1] === 'press')?.[2]).toEqual(['100', '144']);
  expect(session.pendingInteractionOutcome).toBeUndefined();
});

test('captureSnapshot does not retry when a tap change appears after a short delay', async () => {
  const sessionName = 'android-delayed-outcome-without-retry';
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.Button',
      label: 'Open drawer',
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
  session.pendingInteractionOutcome = {
    action: 'click',
    command: 'press',
    positionals: ['100', '144'],
    flags: { platform: 'android' },
    markedAt: Date.now(),
    attemptsRemaining: 2,
    preSignature: buildInteractionSurfaceSignature(baselineNodes),
  };

  let snapshotCalls = 0;
  mockDispatch.mockImplementation(async (_device, command) => {
    expect(command).toBe('snapshot');
    snapshotCalls += 1;
    return {
      nodes: snapshotCalls === 1 ? baselineNodes : changedNodes,
      backend: 'android',
    };
  });

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Albums' })]),
  );
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['snapshot', 'snapshot']);
  expect(session.pendingInteractionOutcome).toBeUndefined();
});

test('captureSnapshot retries pending tap outcome before post-gesture stabilization', async () => {
  const sessionName = 'android-maestro-tap-outcome-before-stabilization';
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = [
    {
      ref: 'e1',
      index: 0,
      depth: 0,
      type: 'android.widget.Button',
      label: 'Navigate to Third',
      hittable: true,
      rect: { x: 302, y: 1301, width: 476, height: 110 },
    },
  ];
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
  };
  session.pendingInteractionOutcome = {
    action: 'click',
    command: 'press',
    positionals: ['540', '1356'],
    flags: { platform: 'android' },
    markedAt: Date.now(),
    attemptsRemaining: 2,
    preSignature: [
      {
        key: '|Navigate to Third||android.widget.Button||enabled|unselected|hittable|#0',
        x: 302,
        y: 1301,
        width: 476,
        height: 110,
      },
    ],
  };
  session.postGestureStabilization = {
    action: 'click',
    markedAt: Date.now(),
  };

  let pressed = false;
  mockDispatch.mockImplementation(async (_device, command) => {
    if (command === 'press') {
      pressed = true;
      return { clicked: true };
    }
    return {
      nodes: !pressed
        ? baselineNodes
        : [
            {
              index: 0,
              depth: 0,
              type: 'android.widget.TextView',
              label: 'Tab Third (3)',
              rect: { x: 390, y: 884, width: 300, height: 55 },
            },
          ],
      backend: 'android',
    };
  });

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Tab Third (3)' })]),
  );
  expect(
    mockDispatch.mock.calls.map((call) => call[1]).filter((command) => command === 'press'),
  ).toEqual(['press']);
  expect(mockDispatch.mock.calls.find((call) => call[1] === 'press')?.[2]).toEqual(['540', '1356']);
  expect(session.pendingInteractionOutcome).toBeUndefined();
  expect(session.postGestureStabilization).toBeUndefined();
});

test('captureSnapshot composes post-gesture stabilization with Android freshness capture', async () => {
  const sessionName = 'android-post-gesture-freshness';
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = Array.from({ length: 18 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  const changedNodes = Array.from({ length: 18 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: index === 0 ? 'album-0' : `Album row ${index + 1}`,
  }));
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'click',
    markedAt: Date.now(),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  };
  session.postGestureStabilization = {
    action: 'click',
    markedAt: Date.now(),
  };

  mockDispatch
    .mockResolvedValueOnce({
      nodes: baselineNodes,
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 18, maxDepth: 1 },
    })
    .mockResolvedValueOnce({
      nodes: changedNodes,
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 18, maxDepth: 1 },
    })
    .mockResolvedValueOnce({
      nodes: changedNodes,
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 18, maxDepth: 1 },
    });

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'album-0' })]),
  );
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual([
    'snapshot',
    'snapshot',
    'snapshot',
  ]);
  expect(session.androidSnapshotFreshness).toBeUndefined();
  expect(session.postGestureStabilization).toBeUndefined();
});

test('captureSnapshot composes pending outcome retry with Android freshness capture', async () => {
  const sessionName = 'android-lazy-outcome-freshness';
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = Array.from({ length: 18 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'click',
    markedAt: Date.now(),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  };
  session.pendingInteractionOutcome = {
    action: 'click',
    command: 'press',
    positionals: ['180', '330'],
    flags: { platform: 'android' },
    markedAt: Date.now(),
    attemptsRemaining: 2,
    preSignature: buildInteractionSurfaceSignature(baselineNodes),
  };

  mockDispatch
    .mockResolvedValueOnce({
      nodes: [],
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 18, maxDepth: 1 },
    })
    .mockResolvedValueOnce({
      nodes: [
        {
          index: 0,
          depth: 0,
          type: 'android.widget.Button',
          label: 'Create document',
          hittable: true,
        },
      ],
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 1, maxDepth: 0 },
    });

  const result = await captureSnapshot({
    device: androidDevice,
    session,
    flags: { snapshotInteractiveOnly: true },
    logPath: '/tmp/daemon.log',
  });

  expect(result.snapshot.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Create document' })]),
  );
  expect(result.freshness).toEqual({
    action: 'click',
    retryCount: 1,
    staleAfterRetries: false,
    reason: undefined,
  });
  expect(mockDispatch.mock.calls.map((call) => call[1])).toEqual(['snapshot', 'snapshot']);
  expect(session.pendingInteractionOutcome).toBeUndefined();
  expect(session.androidSnapshotFreshness).toBeUndefined();
});

test('wait text on Android uses freshness-aware capture instead of one-shot snapshot polling', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-wait-freshness';
  const session = makeSession(sessionName, androidDevice);
  const baselineNodes = Array.from({ length: 18 }, (_, index) => ({
    ref: `e${index + 1}`,
    index,
    depth: 0,
    type: 'android.widget.TextView',
    label: `Inbox row ${index + 1}`,
  }));
  session.snapshot = {
    nodes: baselineNodes,
    createdAt: Date.now(),
    backend: 'android',
    comparisonSafe: true,
  };
  session.androidSnapshotFreshness = {
    action: 'press',
    markedAt: Date.now(),
    baselineCount: baselineNodes.length,
    baselineSignatures: buildSnapshotSignatures(baselineNodes),
    routeComparable: true,
  };
  sessionStore.set(sessionName, session);

  mockDispatch
    .mockResolvedValueOnce({
      nodes: Array.from({ length: 18 }, (_, index) => ({
        index,
        depth: 0,
        type: 'android.widget.TextView',
        label: `Inbox row ${index + 1}`,
      })),
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 18, maxDepth: 1 },
    })
    .mockResolvedValueOnce({
      nodes: [
        { index: 0, depth: 0, type: 'android.widget.TextView', label: 'Create document' },
        { index: 1, depth: 0, type: 'android.widget.TextView', label: 'Done' },
      ],
      truncated: false,
      backend: 'android',
      analysis: { rawNodeCount: 2, maxDepth: 1 },
    });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['Create document', '50'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.text).toBe('Create document');
  }
  expect(mockDispatch).toHaveBeenCalledTimes(2);
  expect(sessionStore.get(sessionName)?.snapshot?.nodes).toEqual(
    expect.arrayContaining([expect.objectContaining({ label: 'Create document' })]),
  );
});

test('wait text timeout includes compact current-surface labels and buttons', async () => {
  const sessionName = 'android-wait-timeout-surface';
  mockDispatch.mockResolvedValue({
    nodes: locationPermissionNodes,
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 4, maxDepth: 1 },
  });

  const response = await runWaitCommand(sessionName, androidDevice, ['Receipt uploaded', '0']);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe(
      'wait timed out for text: Receipt uploaded. Current surface: Location permission, Allow location access?, Not now, Continue.',
    );
    expect(response.error.details?.currentSurface).toEqual({
      labels: ['Location permission', 'Allow location access?', 'Not now', 'Continue'],
      buttons: ['Not now', 'Continue'],
    });
  }
});

test('wait selector timeout includes compact current-surface details', async () => {
  const sessionName = 'android-wait-selector-timeout-surface';
  mockDispatch.mockResolvedValue({
    nodes: locationRequiredNodes,
    truncated: false,
    backend: 'android',
    analysis: { rawNodeCount: 2, maxDepth: 0 },
  });

  const response = await runWaitCommand(sessionName, androidDevice, ['id=receipt-uploaded', '0']);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe(
      'wait timed out for selector: id=receipt-uploaded. Current surface: Location required, Dismiss.',
    );
    expect(response.error.details?.currentSurface).toEqual({
      labels: ['Location required', 'Dismiss'],
      buttons: ['Dismiss'],
    });
  }
});

test('wait timeout summary prefers content labels over chrome and identifier noise', async () => {
  const sessionName = 'ios-wait-timeout-surface-summary';
  mockRunnerCommand.mockResolvedValue({ found: false });
  mockDispatch.mockResolvedValue({
    nodes: iosSurfaceSummaryNodes,
    truncated: false,
    backend: 'xctest',
  });

  const response = await runWaitCommand(sessionName, iosSimulatorDevice, [
    'Impossible success text',
    '0',
  ]);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe(
      'wait timed out for text: Impossible success text. Current surface: Confirm catalog refresh, Keep browsing.',
    );
    expect(response.error.details?.currentSurface).toEqual({
      labels: [
        'Confirm catalog refresh',
        'Keep browsing',
        'host.exp.exponent:id/reload_button',
        'Expo Go',
        'gearshape.fill',
        'Tab Bar',
      ],
      buttons: ['Keep browsing', 'host.exp.exponent:id/reload_button'],
    });
  }
});

test('wait timeout preserves current behavior when current-surface inspection fails', async () => {
  const sessionName = 'android-wait-timeout-surface-fails';
  mockDispatch.mockRejectedValue(new Error('snapshot unavailable'));

  const response = await runWaitCommand(sessionName, androidDevice, ['Receipt uploaded', '0']);

  expect(response?.ok).toBe(false);
  if (response && !response.ok) {
    expect(response.error.message).toBe('wait timed out for text: Receipt uploaded');
    expect(response.error.details).toBeUndefined();
  }
});

test('settings rejects unsupported iOS physical devices', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-device';
  sessionStore.set(
    sessionName,
    makeSession(sessionName, {
      platform: 'ios',
      id: 'ios-device-1',
      name: 'My iPhone',
      kind: 'device',
      booted: true,
    }),
  );

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'settings',
      positionals: ['wifi', 'on'],
      flags: {},
    },
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
    req: {
      token: 't',
      session: sessionName,
      command: 'settings',
      positionals: ['clear-app-state', 'org.reactnavigation.playground'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledWith(
    iosSimulatorDevice,
    'settings',
    ['clear-app-state', 'clear', 'org.reactnavigation.playground'],
    undefined,
    expect.objectContaining({ appBundleId: 'org.reactnavigation.playground' }),
  );
});

test('settings clear-app-state rejects missing app id when no app session is bound', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-clear-state-missing-app';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'settings',
      positionals: ['clear-app-state'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('INVALID_ARGS');
    expect(response.error.message).toMatch(/requires an app id/i);
  }
  expect(mockDispatch).not.toHaveBeenCalled();
});

test('settings usage hint documents canonical faceid states', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'settings',
      positionals: [],
      flags: {},
    },
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
    req: {
      token: 't',
      session: sessionName,
      command: 'settings',
      positionals: ['wifi', 'on'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(false);
  expect(mockDispatch).not.toHaveBeenCalled();
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

test('diff rejects unsupported kind', async () => {
  const sessionStore = makeSessionStore();
  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: 'default',
      command: 'diff',
      positionals: ['unknown'],
      flags: {},
    },
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
    req: {
      token: 't',
      session: 'default',
      command: 'diff',
      positionals: ['screenshot'],
      flags: {},
    },
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

test('wait text uses Apple runner path on macOS desktop sessions', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'macos-wait';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, macOsDevice),
    appBundleId: 'com.apple.systempreferences',
  });

  mockRunnerCommand.mockResolvedValue({ found: true });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['Accessibility', '10'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(mockRunnerCommand).toHaveBeenCalledTimes(1);
  const callArgs = mockRunnerCommand.mock.calls[0];
  expect((callArgs?.[1] as any)?.command).toBe('findText');
  expect((callArgs?.[1] as any)?.text).toBe('Accessibility');
});

test('wait text on iOS without app bundle id uses snapshot path', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-wait-no-app-bundle';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  mockDispatch.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Window',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'StaticText',
        label: 'Agent Device Tester',
        rect: { x: 20, y: 80, width: 240, height: 40 },
      },
    ],
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['Agent Device Tester', '5000'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(mockRunnerCommand).not.toHaveBeenCalled();
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.anything(),
    'snapshot',
    [],
    undefined,
    expect.anything(),
  );
});

// fallow-ignore-next-line complexity
test('wait selector uses direct iOS selector query when possible', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-wait-selector';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, iosSimulatorDevice),
    appBundleId: 'com.example.app',
  });

  mockRunnerCommand.mockResolvedValue({
    found: true,
    nodes: [
      {
        ref: 'e1',
        type: 'Button',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 120, height: 44 },
      },
    ],
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['id="continue-button"', '5000'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  if (response?.ok) {
    expect(response.data?.selector).toBe('id="continue-button"');
  }
  expect(mockRunnerCommand).toHaveBeenCalledTimes(1);
  const callArgs = mockRunnerCommand.mock.calls[0];
  expect((callArgs?.[1] as any)?.command).toBe('querySelector');
  expect((callArgs?.[1] as any)?.selectorKey).toBe('id');
  expect((callArgs?.[1] as any)?.selectorValue).toBe('continue-button');
});

test('wait selector falls back to snapshot runtime when direct iOS selector misses', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-wait-selector-fallback';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, iosSimulatorDevice),
    appBundleId: 'com.example.app',
  });

  mockRunnerCommand.mockResolvedValue({ found: false });
  mockDispatch.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Window',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        identifier: 'continue-button',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 120, height: 44 },
      },
    ],
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['id="continue-button"', '5000'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(mockRunnerCommand).toHaveBeenCalledTimes(1);
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.anything(),
    'snapshot',
    [],
    undefined,
    expect.anything(),
  );
});

test('wait selector bypasses fresh snapshot cache after direct iOS selector misses', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-wait-selector-fresh-snapshot';
  const session = {
    ...makeSession(sessionName, iosSimulatorDevice),
    appBundleId: 'com.example.app',
  };
  session.snapshot = {
    createdAt: Date.now(),
    presentationKey: buildSnapshotPresentationKey({}),
    nodes: [
      {
        ref: 'e0',
        index: 0,
        type: 'Window',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
    ],
  };
  sessionStore.set(sessionName, session);

  mockRunnerCommand.mockResolvedValue({ found: false });
  mockDispatch.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Window',
        rect: { x: 0, y: 0, width: 390, height: 844 },
      },
      {
        index: 1,
        depth: 1,
        parentIndex: 0,
        type: 'Button',
        identifier: 'continue-button',
        label: 'Continue',
        rect: { x: 10, y: 20, width: 120, height: 44 },
      },
    ],
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['id="continue-button"', '5000'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.anything(),
    'snapshot',
    [],
    undefined,
    expect.anything(),
  );
});

test('wait selector does not snapshot-fallback on ambiguous direct iOS selector match', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-wait-selector-ambiguous';
  sessionStore.set(sessionName, {
    ...makeSession(sessionName, iosSimulatorDevice),
    appBundleId: 'com.example.app',
  });

  mockRunnerCommand.mockRejectedValue(
    new AppError('AMBIGUOUS_MATCH', 'Selector matched multiple elements'),
  );

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['id="continue-button"', '5000'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(false);
  if (response?.ok === false) {
    expect(response.error.code).toBe('AMBIGUOUS_MATCH');
  }
  expect(mockDispatch).not.toHaveBeenCalledWith(
    expect.anything(),
    'snapshot',
    expect.anything(),
    expect.anything(),
    expect.anything(),
  );
});

test('wait selector bypasses a fresh matching session snapshot', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'android-wait-fresh-capture';
  const session = makeSession(sessionName, androidDevice);
  session.snapshot = {
    createdAt: Date.now(),
    presentationKey: buildSnapshotPresentationKey({}),
    nodes: [
      {
        ref: 'e1',
        index: 0,
        type: 'android.widget.TextView',
        label: 'Ready',
      },
    ],
  };
  sessionStore.set(sessionName, session);
  mockDispatch.mockResolvedValue({
    nodes: [
      {
        index: 0,
        type: 'android.widget.TextView',
        label: 'Ready',
      },
    ],
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['label="Ready"', '5000'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response?.ok).toBe(true);
  expect(mockDispatch).toHaveBeenCalledWith(
    expect.anything(),
    'snapshot',
    [],
    undefined,
    expect.anything(),
  );
});

test('alert accept retries on "alert not found" and succeeds on second attempt', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  let calls = 0;
  mockRunnerCommand.mockImplementation(async () => {
    calls += 1;
    if (calls === 1) throw new AppError('COMMAND_FAILED', 'alert not found');
    return { accepted: true };
  });

  const response = await handleSnapshotCommands({
    req: { token: 't', session: sessionName, command: 'alert', positionals: ['accept'], flags: {} },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toBe(2);
});

test('alert accept does not retry on non-alert errors', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  let calls = 0;
  mockRunnerCommand.mockImplementation(async () => {
    calls += 1;
    throw new AppError('COMMAND_FAILED', 'runner crashed');
  });

  await expect(
    handleSnapshotCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'alert',
        positionals: ['accept'],
        flags: {},
      },
      sessionName,
      logPath: '/tmp/daemon.log',
      sessionStore,
    }),
  ).rejects.toThrow('runner crashed');

  expect(calls).toBe(1);
});

test('alert accept adds a scoped-snapshot hint after retrying alert-not-found failures', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  mockRunnerCommand.mockRejectedValue(new AppError('COMMAND_FAILED', 'alert not found'));

  let thrown: unknown;
  try {
    await handleSnapshotCommands({
      req: {
        token: 't',
        session: sessionName,
        command: 'alert',
        positionals: ['accept'],
        flags: {},
      },
      sessionName,
      logPath: '/tmp/daemon.log',
      sessionStore,
    });
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toBeInstanceOf(AppError);
  expect((thrown as AppError).message).toBe('alert not found');
  expect((thrown as AppError).details?.hint).toMatch(/scoped snapshot/i);
});

test('alert dismiss retries on "no alert" message', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  let calls = 0;
  mockRunnerCommand.mockImplementation(async () => {
    calls += 1;
    if (calls < 3) throw new AppError('COMMAND_FAILED', 'no alert present');
    return { dismissed: true };
  });

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'alert',
      positionals: ['dismiss'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
  expect(calls).toBe(3);
});

test('wait sleep bypasses sessionless runner cleanup wrapper', async () => {
  const sessionStore = makeSessionStore();
  const sessionName = 'ios-sim';
  sessionStore.set(sessionName, makeSession(sessionName, iosSimulatorDevice));

  const response = await handleSnapshotCommands({
    req: {
      token: 't',
      session: sessionName,
      command: 'wait',
      positionals: ['0'],
      flags: {},
    },
    sessionName,
    logPath: '/tmp/daemon.log',
    sessionStore,
  });

  expect(response).toBeTruthy();
  expect(response?.ok).toBe(true);
});

test('sessionless iOS runner cleanup stops the runner host app', async () => {
  const result = await withSessionlessRunnerCleanup(undefined, iosSimulatorDevice, async () => {
    return 'ok';
  });

  expect(result).toBe('ok');
  expect(mockStopIosRunnerSession).toHaveBeenCalledWith(iosSimulatorDevice.id);
  expect(mockCloseIosApp).toHaveBeenCalledWith(
    iosSimulatorDevice,
    'com.callstack.agentdevice.runner',
  );
});

test('sessionless iOS runner host close is best effort', async () => {
  mockCloseIosApp.mockRejectedValueOnce(new Error('terminate failed'));

  const result = await withSessionlessRunnerCleanup(undefined, iosSimulatorDevice, async () => {
    return 'ok';
  });

  expect(result).toBe('ok');
  expect(mockStopIosRunnerSession).toHaveBeenCalledWith(iosSimulatorDevice.id);
  expect(mockCloseIosApp).toHaveBeenCalledWith(
    iosSimulatorDevice,
    'com.callstack.agentdevice.runner',
  );
});
