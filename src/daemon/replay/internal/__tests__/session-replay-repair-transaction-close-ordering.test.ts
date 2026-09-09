/**
 * ADR 0012 decision 6 repair-transaction close-ordering guarantees (BLOCKER 2/3 sequencing): the
 * platform close must run and succeed BEFORE the healed `.ad` commits (never claim a successful
 * close a failed platform op didn't perform), a retry after a successful platform close but a
 * failed commit never re-dispatches that platform close, a competing writer can never clobber a
 * COMPLETE artifact, and close identity is tracked per TARGETED app so an untargeted close or a
 * differently-targeted retry never wrongly skips the platform close.
 *
 * Split out of `session-replay-repair-transaction.test.ts` once that file crossed the module-size
 * tripwire (docs/agents/testing.md) — see that file's own header for the shared repair-transaction
 * background (Fix 1/2/3).
 */
import { test, expect, vi, beforeEach } from 'vitest';

vi.mock('@agent-device/platform-apple/runner/operations', () => ({
  prewarmIosRunnerSession: vi.fn(),
  resolveRunnerAppBundleId: vi.fn(),
  scheduleIosRunnerIdleStop: vi.fn(),
  stopIosRunnerSession: vi.fn(),
}));
vi.mock('@agent-device/platform-apple/perf', () => ({
  cleanupAppleXctracePerfCapture: vi.fn(async () => ({})),
}));
vi.mock('@agent-device/host-kit/command', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-device/host-kit/command')>();
  return { ...actual, runCmd: vi.fn() };
});
vi.mock('../../../../platform-runtime-runtime-hints.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../../platform-runtime-runtime-hints.ts')>();
  return { ...actual, clearRuntimeHintValues: vi.fn(async () => {}) };
});
vi.mock('@agent-device/device-selection/dispatch-resolve', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, resolveTargetDevice: vi.fn() };
});
vi.mock('../../../snapshot-interactor-capture.ts', () => ({
  captureSnapshotWithInteractor: vi.fn(),
}));
import fs from 'node:fs';
import path from 'node:path';
import { captureSnapshotWithInteractor } from '../../../snapshot-interactor-capture.ts';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { dispatchApplicationLifecycleEffect } from '../../../__tests__/application-lifecycle-runtime-fixture.ts';
import { AppError } from '@agent-device/kernel/errors';
import { HEAL_COMPLETE_SENTINEL } from '../../../session-script-writer.ts';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import type { SessionState } from '../../../session-state.ts';
import { freshEvidence } from './session-replay-repair.fixtures.ts';
import {
  handleCloseCommand,
  makeCompleteRepairSession,
  setup,
} from './session-replay-repair-transaction.fixtures.ts';

const mockDispatchCommand = legacyDispatchCapture;
const mockCaptureSnapshotWithInteractor = vi.mocked(captureSnapshotWithInteractor);
const mockLifecycleDispatch = vi.mocked(dispatchApplicationLifecycleEffect);

/** The recorded platform-close receipt identity, or `undefined` outside a repair transaction. */
function sessionCloseReceipt(session: SessionState | undefined): string | undefined {
  return session?.scriptPublication?.kind === 'repair'
    ? session.scriptPublication.closeReceipt
    : undefined;
}

beforeEach(() => {
  resetLegacySnapshotCapture(mockCaptureSnapshotWithInteractor);
  mockLifecycleDispatch.mockReset();
  mockLifecycleDispatch.mockResolvedValue(undefined);
  // The "current" app state: "save" was renamed to "save-v2" (why step 2
  // diverges), matching the target verification the SAVE_ANNOTATION triggers.
  mockDispatchCommand.mockResolvedValue({
    nodes: [
      {
        index: 0,
        depth: 0,
        type: 'Button',
        identifier: 'save-v2',
        label: 'Save V2',
        rect: { x: 10, y: 10, width: 40, height: 20 },
      },
    ],
    truncated: false,
    backend: 'xctest',
  });
});

test('BLOCKER 2 (new): a repair close whose PLATFORM close fails never commits a healed .ad claiming a successful close', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-platform-close-fail-',
  );
  const session = makeCompleteRepairSession(sessionStore, sessionName, root);
  const healedPath = path.join(root, 'flow.healed.ad');

  // A targeted close (an explicit positional app target) is what makes
  // `dispatchTargetedPlatformClose` actually dispatch instead of no-op.
  const platformCloseError = new AppError('DEVICE_UNAVAILABLE', 'platform close failed', {
    reason: 'device_disconnected',
    hint: 'Reconnect the device and retry close.',
    // BLOCKER 2 (second follow-up): the underlying platform error's own
    // diagnosticId/logPath must survive normalization, never be flattened away.
    diagnosticId: 'diag-platform-close-1',
    logPath: '/tmp/platform-close-1.log',
  });
  mockLifecycleDispatch.mockRejectedValueOnce(platformCloseError);

  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  // The prior implementation committed (recorded a successful `close` +
  // published the healed .ad) BEFORE the platform close ran at all, so a
  // failing platform close still left a COMMITTED artifact on disk claiming
  // success, contradicting the failed-close lifecycle contract. Fixed: the
  // platform close runs first, so a failure here means NOTHING was committed.
  expect(fs.existsSync(healedPath)).toBe(false);
  expect(closeResponse.ok).toBe(false);
  if (!closeResponse.ok) {
    expect(closeResponse.error.code).toBe('DEVICE_UNAVAILABLE');
    // BLOCKER 3 (original): the session was kept for retry — `retriable`
    // must agree. BLOCKER 2 (second follow-up): at the TOP level, and the
    // underlying platform error's diagnosticId/logPath/details are preserved
    // rather than discarded.
    expect(closeResponse.error.retriable).toBe(true);
    expect(closeResponse.error.details?.retriable).toBeUndefined();
    expect(closeResponse.error.diagnosticId).toBe('diag-platform-close-1');
    expect(closeResponse.error.logPath).toBe('/tmp/platform-close-1.log');
    expect(closeResponse.error.details?.reason).toBe('device_disconnected');
  }
  // BLOCKER 2b-style contract: the session stays addressable, untouched, so
  // the agent can fix the cause (e.g. reconnect the device) and retry.
  expect(sessionStore.get(sessionName)).toBe(session);
  expect(session.actions.some((a) => a.command === 'close')).toBe(false);

  // Retry once the platform close succeeds: commits cleanly.
  mockLifecycleDispatch.mockResolvedValueOnce(undefined);
  const retry = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(retry.ok).toBe(true);
  expect(fs.existsSync(healedPath)).toBe(true);
  const healedScript = fs.readFileSync(healedPath, 'utf8');
  expect(healedScript).toContain(HEAL_COMPLETE_SENTINEL);
  expect(
    parseReplayScriptDetailed(healedScript).actions.filter((a) => a.command === 'close'),
  ).toHaveLength(1);
});

test('BLOCKER 3 (second follow-up): a retry after a SUCCESSFUL platform close but a FAILED commit never re-dispatches the platform close', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-close-idempotent-',
  );
  makeCompleteRepairSession(sessionStore, sessionName, root);
  const healedPath = path.join(root, 'flow.healed.ad');
  // A prior COMPLETE (sentinel-marked) healed artifact already sits at the
  // default path — the commit must refuse to clobber it, giving a
  // deterministic commit FAILURE after a platform close that genuinely
  // succeeds (the lifecycle seam's `beforeEach` default resolves). A
  // targeted close (an explicit positional app target) is what makes
  // `dispatchTargetedPlatformClose` actually dispatch instead of no-op.
  fs.writeFileSync(
    healedPath,
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );
  const before = fs.readFileSync(healedPath, 'utf8');

  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: {},
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  // The platform close genuinely ran and succeeded; the SUBSEQUENT commit
  // failed (no-clobber) — the session is retained for retry.
  expect(mockLifecycleDispatch).toHaveBeenCalledTimes(1);
  expect(closeResponse.ok).toBe(false);
  if (!closeResponse.ok) expect(closeResponse.error.message).toMatch(/already exists/);
  expect(sessionStore.get(sessionName)).toBeDefined();
  expect(fs.readFileSync(healedPath, 'utf8')).toBe(before);
  expect(sessionCloseReceipt(sessionStore.get(sessionName))).toBeDefined();

  // Retry with an explicit path: the ALREADY-SUCCEEDED platform close must
  // NEVER be dispatched again — a non-idempotent backend could fail (or
  // wedge recovery entirely) on a second close of an already-closed target.
  const retryPath = path.join(root, 'flow.promoted.ad');
  const retry = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: { saveScript: retryPath },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  // Still exactly ONE dispatch total — the retry consumed the recorded
  // success and went straight to the commit.
  expect(mockLifecycleDispatch).toHaveBeenCalledTimes(1);
  expect(retry.ok).toBe(true);
  expect(fs.existsSync(retryPath)).toBe(true);
  const promoted = fs.readFileSync(retryPath, 'utf8');
  expect(promoted).toContain(HEAL_COMPLETE_SENTINEL);
});

test('BLOCKER 3: a competing second writer never overwrites a COMPLETE artifact and gets a clear no-clobber error', async () => {
  const { root, sessionStore, sessionName } = setup('agent-device-repair-transaction-competing-');
  const healedPath = path.join(root, 'flow.healed.ad');

  // Writer 1 commits a complete artifact at the default healed path.
  const first = makeCompleteRepairSession(sessionStore, `${sessionName}-1`, root);
  const r1 = sessionStore.writeSessionLog(first);
  expect(r1.written).toBe(true);
  const committed = fs.readFileSync(healedPath, 'utf8');
  expect(committed).toContain(HEAL_COMPLETE_SENTINEL);

  // Writer 2 (a second repair on the same source → same default path) attempts
  // to publish over it. The atomic create-exclusive publish must FAIL rather
  // than overwrite the complete artifact.
  const second = makeCompleteRepairSession(sessionStore, `${sessionName}-2`, root);
  second.actions[1] = {
    ts: 2,
    command: 'press',
    positionals: ['@e9'],
    flags: {},
    result: { selectorChain: ['id="different"'] },
    targetEvidence: freshEvidence('different', 'Different'),
  };
  const r2 = sessionStore.writeSessionLog(second);
  expect(r2.written).toBe(false);
  expect(r2.written === false && r2.error?.message).toMatch(/already exists/);
  // The first writer's complete artifact is byte-for-byte intact.
  expect(fs.readFileSync(healedPath, 'utf8')).toBe(committed);
});

test('BLOCKER 3 (third follow-up): an untargeted close that performed NO platform operation never lets a targeted retry skip the platform close', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-close-identity-untargeted-',
  );
  makeCompleteRepairSession(sessionStore, sessionName, root);
  const healedPath = path.join(root, 'flow.healed.ad');
  // A prior COMPLETE artifact already sits at the default path so the commit
  // deterministically fails and the session is retained for retry.
  fs.writeFileSync(
    healedPath,
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );

  // First attempt: UNTARGETED close — `shouldDispatchPlatformClose` is false
  // (no positional target, not `web`), so the platform close never dispatches
  // at all; the commit then fails (no-clobber).
  const first = await handleCloseCommand({
    req: { token: 't', session: sessionName, command: 'close', positionals: [], flags: {} },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(first.ok).toBe(false);
  expect(mockLifecycleDispatch).not.toHaveBeenCalled();
  expect(sessionStore.get(sessionName)).toBeDefined();

  const retry = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app'],
      flags: { saveScript: path.join(root, 'flow.promoted.ad') },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(mockLifecycleDispatch).toHaveBeenCalledTimes(1);
  expect(mockLifecycleDispatch.mock.calls[0]?.[2]).toEqual(['com.example.app']);
  expect(retry.ok).toBe(true);
});

test('BLOCKER 3 (third follow-up): a retry targeting a DIFFERENT app than the succeeded close never skips the platform close for the new target', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-close-identity-changed-target-',
  );
  makeCompleteRepairSession(sessionStore, sessionName, root);
  const healedPath = path.join(root, 'flow.healed.ad');
  fs.writeFileSync(
    healedPath,
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );

  // First attempt targets app-a; the platform close succeeds, the commit fails.
  const first = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app-a'],
      flags: {},
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(first.ok).toBe(false);
  expect(mockLifecycleDispatch).toHaveBeenCalledTimes(1);
  expect(sessionCloseReceipt(sessionStore.get(sessionName))).toBeDefined();

  // Retry targets a DIFFERENT app (app-b) — a genuinely different platform
  // operation. The prior session-wide marker would wrongly treat app-b as
  // already closed just because SOME close succeeded. It must dispatch again,
  // against app-b specifically.
  const retry = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: ['com.example.app-b'],
      flags: { saveScript: path.join(root, 'flow.promoted.ad') },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(mockLifecycleDispatch).toHaveBeenCalledTimes(2);
  expect(mockLifecycleDispatch.mock.calls[1]?.[2]).toEqual(['com.example.app-b']);
  expect(retry.ok).toBe(true);
});
