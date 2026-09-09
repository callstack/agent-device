/**
 * ADR 0012 decision 6 repair-transaction `--force`/`--overwrite` semantics (#1258): a
 * `--save-script` target that already exists is refused at arm time, before any step runs, unless
 * `--force` opts in; the opt-in is sticky across a `--from` continuation on the SAME target, but a
 * retarget to a different path drops it unless the retarget leg carries its own live `--force`.
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
import { runReplayForTest } from '../../__tests__/replay-command-fixture.ts';
import { captureSnapshotWithInteractor } from '../../../snapshot-interactor-capture.ts';
import {
  legacyDispatchCapture,
  resetLegacySnapshotCapture,
} from '../../../__tests__/legacy-snapshot-capture-fixture.ts';
import { dispatchApplicationLifecycleEffect } from '../../../__tests__/application-lifecycle-runtime-fixture.ts';
import { repairPublication } from '../../../../__tests__/test-utils/session-factories.ts';
import { HEAL_COMPLETE_SENTINEL } from '../../../session-script-writer.ts';
import {
  repairSessionBoundary,
  markRepairTransactionComplete,
} from '../../../session-replay-transaction.ts';
import {
  NO_SCRIPT_PUBLICATION,
  scriptTargetPath,
  scriptTargetForce,
} from '../../../session-script-publication-state.ts';
import { parseReplayScriptDetailed } from '@agent-device/ad-script';
import type { DaemonRequest } from '../../../daemon-request.ts';
import type { SessionState } from '../../../session-state.ts';
import {
  baseReplayRequest as baseReq,
  writeReplayFile,
} from '../../__tests__/session-replay-runtime.fixtures.ts';
import { freshEvidence, makeRecordingReplayInvoke } from './session-replay-repair.fixtures.ts';
import {
  handleCloseCommand,
  makeCompleteRepairSession,
  SAVE_ANNOTATION,
  setup,
} from './session-replay-repair-transaction.fixtures.ts';

const mockDispatchCommand = legacyDispatchCapture;
const mockCaptureSnapshotWithInteractor = vi.mocked(captureSnapshotWithInteractor);
const mockLifecycleDispatch = vi.mocked(dispatchApplicationLifecycleEffect);

/** The persisted per-target overwrite grant (#1258), or `false` outside any publication. */
function sessionTargetForce(session: SessionState | undefined): boolean {
  return scriptTargetForce(session?.scriptPublication ?? NO_SCRIPT_PUBLICATION);
}

/** The explicit publication target path, or `undefined` for none/default. */
function sessionTargetPath(session: SessionState | undefined): string | undefined {
  return scriptTargetPath(session?.scriptPublication ?? NO_SCRIPT_PUBLICATION);
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

test('#1258: close --save-script --force overwrites an existing COMPLETE healed .ad instead of refusing', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-force-overwrite-',
  );
  makeCompleteRepairSession(sessionStore, sessionName, root);
  // A prior COMPLETE (sentinel-marked) healed artifact already sits at the
  // default path — `--force` must overwrite it instead of refusing.
  fs.writeFileSync(
    path.join(root, 'flow.healed.ad'),
    `context platform=ios device="x"\nclick id="old"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );

  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { force: true },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  expect(closeResponse.ok).toBe(true);
  expect(sessionStore.get(sessionName)).toBeUndefined();
  const healedPath = path.join(root, 'flow.healed.ad');
  if (closeResponse.ok) expect(closeResponse.data?.savedScript).toBe(healedPath);
  const script = fs.readFileSync(healedPath, 'utf8');
  expect(script).toContain(HEAL_COMPLETE_SENTINEL);
  const parsed = parseReplayScriptDetailed(script);
  // The new repair's own actions replaced the stale prior artifact — the old
  // content is gone, never merged/appended.
  expect(parsed.actions.some((a) => a.positionals[0] === 'id="old"')).toBe(false);
  expect(parsed.actions.map((a) => a.command)).toEqual(['open', 'press', 'close']);
});

test('#1258 arm-time preflight: an existing --save-script target rejects BEFORE any step runs', async () => {
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-repair-transaction-arm-preflight-',
  );
  const filePath = writeReplayFile(root, ['open "Demo" --relaunch', 'close']);
  // The default healed sibling already exists — a prior repair, or an
  // unrelated stale file sitting at that path.
  fs.writeFileSync(path.join(root, 'flow.healed.ad'), 'context platform=ios device="x"\n');

  const spy: DaemonRequest[] = [];
  const invoke = makeRecordingReplayInvoke({ sessionStore, sessionName, spy });

  const result = await runReplayForTest({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.error.code).toBe('COMMAND_FAILED');
    expect(result.error.message).toMatch(/already exists/);
  }
  // Not a single step dispatched — the preflight fired BEFORE the loop, not
  // merely at the end (publish time). Even `open` never ran.
  expect(spy).toHaveLength(0);
  // The session was never armed (no boundary stamped) either — the whole
  // repair-arm side effect is skipped, not just the dispatch.
  expect(repairSessionBoundary(sessionStore.get(sessionName))).toBeUndefined();
});

test('#1258: --force skips the arm-time preflight and the replay proceeds despite the existing target', async () => {
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-repair-transaction-arm-preflight-force-',
  );
  const filePath = writeReplayFile(root, ['open "Demo" --relaunch', 'close']);
  fs.writeFileSync(path.join(root, 'flow.healed.ad'), 'context platform=ios device="x"\n');

  const spy: DaemonRequest[] = [];
  const invoke = makeRecordingReplayInvoke({ sessionStore, sessionName, spy });

  const result = await runReplayForTest({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true, force: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });

  expect(result.ok).toBe(true);
  // `open` dispatched — the preflight did not block it. The terminal `close`
  // is skipped while repair-armed (existing, unrelated behavior), so `open`
  // is the only step this minimal script actually dispatches.
  expect(spy.map((r) => r.command)).toEqual(['open']);
  // `force` is persisted on the session from arm time, so a LATER commit
  // (e.g. a bare `close`, or teardown) still honors the overwrite.
  expect(sessionTargetForce(sessionStore.get(sessionName))).toBe(true);
});

test('#1258 preflight honors PERSISTED force: a --from continuation without --force is NOT rejected on an existing target a prior --force leg authorized', async () => {
  const { root, sessionStore, sessionName, logPath } = setup(
    'agent-device-repair-transaction-preflight-persisted-force-',
  );
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
    'close',
  ]);
  // The healed target already exists — the preflight WOULD reject a
  // continuation that only saw the (absent, this leg) LIVE force flag.
  fs.writeFileSync(path.join(root, 'flow.healed.ad'), 'context platform=ios device="x"\n');
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    evidence: (req) => (req.command === 'click' ? freshEvidence('confirm', 'Confirm') : undefined),
  });

  // Leg 1: `replay --save-script --force` — the LIVE force passes the preflight
  // (target exists), arms the session, PERSISTS saveScriptForce, then diverges
  // (nothing published, so the pre-existing target survives).
  const leg1 = await runReplayForTest({
    req: baseReq({ positionals: [filePath], flags: { saveScript: true, force: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  expect(leg1.error.code).toBe('REPLAY_DIVERGENCE');
  const divergence = leg1.error.details?.divergence as { resume: { planDigest: string } };
  expect(sessionTargetForce(sessionStore.get(sessionName))).toBe(true);

  // The agent's corrective press (blessed @ref), recorded live.
  const session = sessionStore.get(sessionName)!;
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e7'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    targetEvidence: freshEvidence('save-v2', 'Save V2'),
  });

  // Leg 2: `replay --from N --save-script` WITHOUT --force — the target still
  // exists. The persisted saveScriptForce must make the arm-time preflight use
  // the SAME effective decision publication uses, so this is NOT rejected.
  const leg2 = await runReplayForTest({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: true, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  // Not rejected by the arm-time preflight (no "already exists"): the
  // transaction reached completion instead.
  expect(leg2.ok).toBe(true);
  expect(sessionStore.get(sessionName)?.scriptPublication).toMatchObject({
    kind: 'repair',
    status: 'complete',
  });
  // A bare-boolean continuation never retargets, so force stays persisted.
  expect(sessionTargetForce(sessionStore.get(sessionName))).toBe(true);
});

test('#1258 preflight is per-target: a --from continuation RETARGETING to an existing <b> WITHOUT live force is refused BEFORE dispatch, preserves the prior COMPLETE transaction, and a later close still commits the ORIGINAL <a>', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-preflight-retarget-',
  );
  const filePath = writeReplayFile(root, [
    'open "Demo" --relaunch',
    SAVE_ANNOTATION,
    'click id="save"',
    'click id="confirm"',
    'close',
  ]);
  const targetA = path.join(root, 'a.ad');
  const targetB = path.join(root, 'b.ad');
  // <b> already exists (nobody opted to overwrite it); <a> does not, so leg 1
  // arms/forces <a> cleanly.
  fs.writeFileSync(targetB, 'context platform=ios device="x"\nclick id="unrelated"\n');
  const beforeB = fs.readFileSync(targetB, 'utf8');
  const spy: DaemonRequest[] = [];
  const invoke = makeRecordingReplayInvoke({
    sessionStore,
    sessionName,
    spy,
    evidence: (req) => (req.command === 'click' ? freshEvidence('confirm', 'Confirm') : undefined),
  });

  // Leg 1: `--save-script=<a> --force` — arms + PERSISTS force for <a>, then
  // diverges (nothing published).
  const leg1 = await runReplayForTest({
    req: baseReq({ positionals: [filePath], flags: { saveScript: targetA, force: true } }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg1.ok).toBe(false);
  if (leg1.ok) return;
  const divergence = leg1.error.details?.divergence as { resume: { planDigest: string } };
  const session = sessionStore.get(sessionName)!;
  expect(sessionTargetPath(session)).toBe(targetA);
  expect(sessionTargetForce(session)).toBe(true);
  // The agent's corrective press.
  sessionStore.recordAction(session, {
    command: 'press',
    positionals: ['@e7'],
    flags: {},
    result: { selectorChain: ['id="save-v2"'] },
    targetEvidence: freshEvidence('save-v2', 'Save V2'),
  });
  // The transaction for <a> has now reached COMPLETE (a resume leg ran to the
  // end) — set directly here, mirroring `makeCompleteRepairSession`'s
  // convention, to isolate THIS test's concern: a later retarget REJECTION must
  // not corrupt this flag (BLOCKER 2 — the C2 `saveScriptComplete = false`
  // reset must run AFTER the preflight's early-return, never before it).
  markRepairTransactionComplete(session);
  const dispatchesBeforeLeg2 = spy.length;

  // Leg 2: `--from N --save-script=<b>` (explicit RETARGET, NO live force) — <b>
  // exists. The persisted force was granted for <a>, and
  // `applySaveScriptRetarget` WOULD clear it for <b>; the preflight must MATCH
  // that per-target contract and REFUSE here, before any step dispatches,
  // instead of executing the leg and only refusing at publish time.
  const leg2 = await runReplayForTest({
    req: baseReq({
      positionals: [filePath],
      flags: { saveScript: targetB, replayFrom: 3, replayPlanDigest: divergence.resume.planDigest },
    }),
    sessionName,
    logPath,
    sessionStore,
    invoke,
  });
  expect(leg2.ok).toBe(false);
  if (!leg2.ok) {
    expect(leg2.error.code).toBe('COMMAND_FAILED');
    expect(leg2.error.message).toMatch(/already exists/);
  }
  // Not a single step of leg 2 dispatched — refused BEFORE the loop.
  expect(spy.length).toBe(dispatchesBeforeLeg2);
  // READ-ONLY: the rejected request left the session target untouched — still
  // armed/forced for <a>, never retargeted to <b>.
  expect(sessionTargetPath(sessionStore.get(sessionName))).toBe(targetA);
  expect(sessionTargetForce(sessionStore.get(sessionName))).toBe(true);
  // BLOCKER 2 (a): the prior COMPLETE transaction SURVIVES the rejection — the
  // C2 completion reset never ran, because the preflight returned first.
  expect(sessionStore.get(sessionName)?.scriptPublication).toMatchObject({
    kind: 'repair',
    status: 'complete',
  });
  // <b> is byte-for-byte untouched.
  expect(fs.readFileSync(targetB, 'utf8')).toBe(beforeB);

  // BLOCKER 2 (b): a later bare `close` still COMMITS the ORIGINAL target <a>
  // (never the rejected <b>) — proof the rejected retarget corrupted neither
  // the completion flag nor the target path.
  const closeResponse = await handleCloseCommand({
    req: { token: 't', session: sessionName, command: 'close', positionals: [], flags: {} },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });
  expect(closeResponse.ok).toBe(true);
  if (closeResponse.ok) expect(closeResponse.data?.savedScript).toBe(targetA);
  expect(fs.existsSync(targetA)).toBe(true);
  const committed = parseReplayScriptDetailed(fs.readFileSync(targetA, 'utf8'));
  expect(committed.actions.map((a) => a.command)).toEqual(['open', 'press', 'close']);
  // <b> stayed untouched through the commit too.
  expect(fs.readFileSync(targetB, 'utf8')).toBe(beforeB);
});

test('#1258 force is per-target: re-arming --save-script=<b> WITHOUT --force drops force persisted for <a>, so <b> is NOT overwritten', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-retarget-clears-force-',
  );
  // Armed and forced for target <a> (flow.healed.ad).
  const session = makeCompleteRepairSession(sessionStore, sessionName, root);
  session.scriptPublication = repairPublication('complete', {
    boundary: 0,
    path: path.join(root, 'flow.healed.ad'),
    force: true,
  });
  // A DIFFERENT, unrelated file already sits at the retarget destination <b>
  // (flow.promoted.ad) — nobody opted to overwrite THIS one.
  const promotedPath = path.join(root, 'flow.promoted.ad');
  fs.writeFileSync(
    promotedPath,
    `context platform=ios device="x"\nclick id="unrelated"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );
  const before = fs.readFileSync(promotedPath, 'utf8');

  // `close --save-script=<b>` (NO --force): retargeting from <a> to <b>
  // without a live opt-in drops the force that was granted for <a>.
  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: promotedPath },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  // Refused — the retarget cleared the sticky force, so <b> is protected by the
  // default no-clobber exactly like a fresh target would be.
  expect(closeResponse.ok).toBe(false);
  if (!closeResponse.ok) expect(closeResponse.error.message).toMatch(/already exists/);
  // <b> is untouched, and the session is kept for retry.
  expect(fs.readFileSync(promotedPath, 'utf8')).toBe(before);
  expect(sessionStore.get(sessionName)).toBeDefined();
  expect(sessionTargetForce(sessionStore.get(sessionName))).toBe(false);
});

test('#1258 force per-target, contrast: re-arming --save-script=<b> WITH --force DOES overwrite <b>', async () => {
  const { root, sessionStore, sessionName, logPath, leaseRegistry } = setup(
    'agent-device-repair-transaction-retarget-force-overwrites-',
  );
  const session = makeCompleteRepairSession(sessionStore, sessionName, root);
  session.scriptPublication = repairPublication('complete', {
    boundary: 0,
    path: path.join(root, 'flow.healed.ad'),
    force: true,
  });
  const promotedPath = path.join(root, 'flow.promoted.ad');
  fs.writeFileSync(
    promotedPath,
    `context platform=ios device="x"\nclick id="unrelated"\n${HEAL_COMPLETE_SENTINEL}\n`,
  );

  // `close --save-script=<b> --force`: the live opt-in re-grants force for the
  // new target, overwriting it.
  const closeResponse = await handleCloseCommand({
    req: {
      token: 't',
      session: sessionName,
      command: 'close',
      positionals: [],
      flags: { saveScript: promotedPath, force: true },
    },
    sessionName,
    logPath,
    sessionStore,
    leaseRegistry,
  });

  expect(closeResponse.ok).toBe(true);
  const parsed = parseReplayScriptDetailed(fs.readFileSync(promotedPath, 'utf8'));
  expect(parsed.actions.some((a) => a.positionals[0] === 'id="unrelated"')).toBe(false);
});
