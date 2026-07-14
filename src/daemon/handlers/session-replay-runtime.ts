import fs from 'node:fs';
import path from 'node:path';
import { parseReplayInput } from '../../compat/replay-input.ts';
import { asAppError } from '../../kernel/errors.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import {
  emitRequestProgress,
  readReplayTestActionProgress,
  type ReplayTestProgressEvent,
} from '../../request/progress.ts';
import { SessionStore } from '../session-store.ts';
import { expandSessionPath } from '../session-paths.ts';
import { type ReplayScriptMetadata } from '../../replay/script.ts';
import { computeReplayPlanDigest } from '../../replay/plan-digest.ts';
import { errorResponse, noActiveSessionError } from './response.ts';
import { invokeReplayAction } from './session-replay-action-runtime.ts';
import { tryParseSelectorChain } from '../../selectors/index.ts';
import type { ResponseLevel } from '../../kernel/contracts.ts';
import {
  buildReplayVarScope,
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
  type ReplayVarScope,
} from '../../replay/vars.ts';
import {
  summarizeSnapshotTimingSamples,
  type SnapshotTimingSample,
} from '../../snapshot-diagnostics.ts';
import type { ReplayCommandResult } from '../../contracts/replay.ts';
import { collectReplayActionArtifactPaths } from './session-replay-runtime-artifacts.ts';
import { withReplayFailureDiagnostics } from './session-replay-runtime-failure.ts';
import {
  buildReplayMetadataFlags,
  readEffectiveReplayPlanDigestMetadata,
  resolveReplayEntryIndex,
} from './session-replay-runtime-plan.ts';
import {
  buildReplayTargetGuardMismatchResponse,
  isReplayTargetGuardMismatchResponse,
  verifyReplayActionTarget,
} from './session-replay-target-verification.ts';

/** Per-run invariants for a single replay step (ADR 0012 step 4 verify + dispatch + guard). */
type ReplayStepContext = {
  scope: ReplayVarScope;
  replayReq: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  resolved: string;
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths: (string | undefined)[] | undefined;
  planDigest: string;
  actionTracePath: string | undefined;
  responseLevel: ResponseLevel | undefined;
  invoke: DaemonInvokeFn;
};

/**
 * ADR 0012 migration step 4: verify the recorded target BEFORE sending the
 * device action. A non-verified outcome is a complete target-binding
 * REPLAY_DIVERGENCE (built from its own pre-action capture); only a verified
 * outcome dispatches, carrying the verified member's identity as a
 * post-resolution guard so dispatch's own resolution (occlusion/visibility
 * guards verification does not replicate) must land on the SAME element or
 * refuse pre-action.
 */
async function resolveReplayStepResponse(
  ctx: ReplayStepContext,
  action: SessionAction,
  index: number,
  artifactPaths: string[],
): Promise<DaemonResponse> {
  const sourcePath = ctx.actionSourcePaths?.[index] ?? ctx.resolved;
  const sourceLine = ctx.actionLines[index] ?? 1;
  const verification = await verifyReplayActionTarget({
    action,
    scope: ctx.scope,
    sourcePath,
    sourceLine,
    replayPath: ctx.resolved,
    step: index + 1,
    sessionName: ctx.sessionName,
    sessionStore: ctx.sessionStore,
    logPath: ctx.logPath,
    artifactPaths,
    responseLevel: ctx.responseLevel,
    planActions: ctx.actions,
    planDigest: ctx.planDigest,
  });
  if (!verification.verified) return verification.response;
  const guard = verification.guard;
  const guardedReq = guard
    ? {
        ...ctx.replayReq,
        internal: { ...ctx.replayReq.internal, replayTargetGuard: guard.expected },
      }
    : ctx.replayReq;
  const response = await invokeReplayAction({
    req: guardedReq,
    sessionName: ctx.sessionName,
    action,
    scope: ctx.scope,
    filePath: ctx.resolved,
    line: sourceLine,
    sourcePath: ctx.actionSourcePaths?.[index],
    step: index + 1,
    tracePath: ctx.actionTracePath,
    invoke: ctx.invoke,
  });
  if (!guard || !isReplayTargetGuardMismatchResponse(response)) return response;
  return await buildReplayTargetGuardMismatchResponse({
    action,
    scope: ctx.scope,
    guard,
    failedResponse: response,
    sourcePath,
    sourceLine,
    replayPath: ctx.resolved,
    step: index + 1,
    sessionName: ctx.sessionName,
    sessionStore: ctx.sessionStore,
    logPath: ctx.logPath,
    artifactPaths,
    responseLevel: ctx.responseLevel,
    planActions: ctx.actions,
    planDigest: ctx.planDigest,
  });
}

// fallow-ignore-next-line complexity
export async function runReplayScriptFile(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  tracePath?: string;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, tracePath, invoke } = params;
  const filePath = req.positionals?.[0];
  if (!filePath) {
    return errorResponse('INVALID_ARGS', 'replay requires a path');
  }

  const startedAt = Date.now();
  let resolved = '';
  const artifactPaths = new Set<string>();
  try {
    resolved = SessionStore.expandHome(filePath, req.meta?.cwd);
    const script = fs.readFileSync(resolved, 'utf8');
    const firstNonWhitespace = script.trimStart()[0];
    if (firstNonWhitespace === '{' || firstNonWhitespace === '[') {
      return errorResponse(
        'INVALID_ARGS',
        'replay accepts .ad script files. JSON replay payloads are no longer supported.',
      );
    }

    const parsed = parseReplayInput(script, req.flags, { sourcePath: resolved });
    const metadata = parsed.metadata;
    const replayReq =
      metadata.platform || metadata.target
        ? { ...req, flags: buildReplayMetadataFlags(req.flags, metadata) }
        : req;
    const actions = parsed.actions;
    const actionLines = parsed.actionLines;
    const actionSourcePaths = parsed.actionSourcePaths;
    const planDigest = computeReplayPlanDigest({
      actions,
      actionLines,
      actionSourcePaths,
      metadata: readEffectiveReplayPlanDigestMetadata(replayReq.flags),
    });
    // ADR 0012 decision 4 / migration step 5: resume preflight, entirely
    // before any device action. `test` never reaches here with either flag
    // set (rejected earlier, in handleSessionReplayCommands). Fetched before
    // any mutation below so the pending record-and-heal watermark (decision
    // 6, R2/R3) reflects this session's state AT REQUEST START, scoping the
    // one-past-the-plan `--from` ordinal to the exact session that produced it.
    const preEntrySession = sessionStore.get(sessionName);
    const entryIndex = resolveReplayEntryIndex(
      req.flags,
      actions.length,
      planDigest,
      actions,
      preEntrySession?.pendingRecordAndHeal,
      preEntrySession?.actions.length ?? 0,
    );
    if (!entryIndex.ok) return entryIndex.response;
    const scope = buildReplayVarScope({
      builtins: buildReplayBuiltinVars({
        req: replayReq,
        sessionName,
        metadata,
        resolvedPath: resolved,
      }),
      fileEnv: metadata.env,
      shellEnv: collectReplayShellEnv(readReplayShellEnvSource(req.flags?.replayShellEnv)),
      cliEnv: parseReplayCliEnvEntries(readReplayCliEnvEntries(req.flags?.replayEnv)),
    });
    const actionTracePath = tracePath ?? sessionStore.get(sessionName)?.trace?.outPath;
    const snapshotDiagnosticSamples: SnapshotTimingSample[] = [];
    // ADR 0012 decision 6, R1/R2/R6: R2 preflight rejects ANY fresh full replay
    // on a session with an active repair run — regardless of `--save-script`
    // this time — because the session stays repair-armed (`recordSession` +
    // `saveScriptBoundary`), so even a plain full replay re-appends the
    // recorded prefix. The armer then stamps the boundary watermark on the
    // session that actually accumulates this run's actions, robust to step-1
    // `open` replacing the session.
    const repairRunPreflight = preflightReplayAgainstActiveRepair({
      entryIndex: entryIndex.value,
      sessionStore,
      sessionName,
    });
    if (repairRunPreflight) return repairRunPreflight;
    // ADR 0012 decision 6, R7 (BLOCKER 1): a `--from` continuation (entryIndex > 0)
    // resumes an EXISTING session — it never replays step 1 (`open`), so it
    // cannot create one. If the session is gone (its repair was idle-reaped),
    // surface SESSION_NOT_FOUND HERE so the router translates it to
    // REPAIR_SESSION_EXPIRED via the tombstone — instead of the missing session
    // surfacing later as a REPLAY_DIVERGENCE that wraps the first step's failure
    // and slips past the tombstone translation.
    if (entryIndex.value > 0 && !sessionStore.get(sessionName)) {
      return noActiveSessionError();
    }
    // ADR 0012 decision 6, R2/R3: `resolveReplayEntryIndex` already proved (or
    // this `from` never matched the watermark at all) that a `record-and-heal`
    // continuation is either not this session's pending target, or that a new
    // action was recorded since the divergence — the corrective press
    // happened. Consume the watermark on the latter so it can never be
    // re-checked against a later, unrelated request.
    if (
      preEntrySession &&
      preEntrySession.pendingRecordAndHeal?.expectedFrom === req.flags?.replayFrom
    ) {
      preEntrySession.pendingRecordAndHeal = undefined;
      sessionStore.set(sessionName, preEntrySession);
    }
    if (req.flags?.saveScript) {
      // ADR 0012 decision 6, R7 (C5a): a fresh `replay --save-script` on this
      // key clears any prior reap tombstone before starting a new transaction.
      sessionStore.clearRepairTombstone(sessionName);
    }
    // ADR 0012 decision 6 (C2): a repair-armed resume re-opens the completion
    // window — a leg that re-diverges must not inherit a prior leg's COMPLETE
    // flag and let a later `close` commit a now-stale transaction.
    const preRunSession = sessionStore.get(sessionName);
    if (preRunSession?.saveScriptBoundary !== undefined) preRunSession.saveScriptComplete = false;
    const armReplaySaveScriptStep = createReplaySaveScriptArmer({
      saveScript: req.flags?.saveScript,
      sessionStore,
      sessionName,
      sourcePath: resolved,
    });
    const failStep = (failedResponse: DaemonResponse, failedAction: SessionAction, index: number) =>
      withReplayFailureDiagnostics({
        response: failedResponse,
        action: failedAction,
        index,
        replayPath: resolved,
        sourcePath: actionSourcePaths?.[index] ?? resolved,
        sourceLine: actionLines[index] ?? 1,
        artifactPaths: [...artifactPaths],
        snapshotDiagnosticSamples,
        scope,
        req,
        sessionName,
        sessionStore,
        logPath,
        planActions: actions,
        planDigest,
      });
    const stepContext: ReplayStepContext = {
      scope,
      replayReq,
      sessionName,
      sessionStore,
      logPath,
      resolved,
      actions,
      actionLines,
      actionSourcePaths,
      planDigest,
      actionTracePath,
      responseLevel: req.meta?.responseLevel,
      invoke,
    };
    for (let index = entryIndex.value; index < actions.length; index += 1) {
      const action = actions[index];
      if (!action || action.command === 'replay') continue;
      // ADR 0012 decision 6, R1 (BLOCKER 4): arm BEFORE the terminal-close
      // check. Pre-`open` arming is a no-op (no session yet), so for a script
      // whose first step CREATES the session (`open`), the boundary is only set
      // once a later iteration runs the armer on the now-existing session.
      // Arming first means a minimal `[open, close]` transaction arms at the
      // `close` step, so `isRepairArmedTerminalClose` then sees the boundary and
      // treats the terminal `close` as lifecycle (skipped) rather than
      // dispatching it and tearing the session down un-armed.
      armReplaySaveScriptStep();
      if (
        isRepairArmedTerminalClose({
          action,
          index,
          totalActions: actions.length,
          sessionStore,
          sessionName,
        })
      ) {
        continue;
      }
      emitReplayTestActionProgress(resolved, index, actions.length, action);
      const sampleStart = readSessionSnapshotSampleCount(sessionStore, sessionName);
      const response = await resolveReplayStepResponse(stepContext, action, index, [
        ...artifactPaths,
      ]);
      snapshotDiagnosticSamples.push(
        ...readSessionSnapshotSamplesSince(sessionStore, sessionName, sampleStart),
      );
      collectReplayActionArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
      if (!response.ok) {
        // ADR 0012 decision 6, R7 (C1): a divergence from a repair-armed run
        // keeps its session live — mark the wire signal so the client keeps the
        // owning daemon alive and the agent knows the session is addressable.
        const held = (r: DaemonResponse): DaemonResponse =>
          markRepairSessionHeldIfArmed({ response: r, sessionStore, sessionName });
        // A complete target-binding divergence must pass through unchanged —
        // failStep would rebuild it as a generic action-failure divergence
        // (double-capture + lost kind/targetBinding).
        if (isCompleteTargetBindingDivergenceResponse(response)) return held(response);
        return held(await failStep(response, action, index));
      }
    }

    // ADR 0012 decision 6, R1 (BLOCKER 4): a final arm so a repair whose LAST
    // executable step created the session (e.g. a bare `[open]`, or `[open,
    // close]` where the close is skipped) still arms the transaction before the
    // completion/commit gate below evaluates it.
    armReplaySaveScriptStep();

    // ADR 0012 decision 6 (C2): the loop reached the last executable step with
    // no outstanding divergence (the terminal source `close` was skipped, C4) —
    // the repair transaction is now COMPLETE and commit-eligible.
    const completedSession = sessionStore.get(sessionName);
    if (completedSession?.saveScriptBoundary !== undefined) {
      completedSession.saveScriptComplete = true;
      sessionStore.set(sessionName, completedSession);
    }

    const replayedCount = actions.length - entryIndex.value;
    const snapshotDiagnosticsSummary = summarizeSnapshotTimingSamples(snapshotDiagnosticSamples);
    const wallClockMs = Date.now() - startedAt;
    return {
      ok: true,
      data: {
        replayed: replayedCount,
        // ADR 0012 migration step 6: `--update` retired as an actor; it never
        // healed anything in this run, so the count is always 0. Kept on the
        // wire shape for existing reporters/consumers (test summary, JUnit).
        healed: 0,
        session: sessionName,
        artifactPaths: [...artifactPaths],
        ...(snapshotDiagnosticsSummary ? { snapshotDiagnostics: snapshotDiagnosticsSummary } : {}),
        // ADR 0012: one-line text success summary; --json shape is additive.
        message: formatReplaySuccessMessage(replayedCount, wallClockMs),
      } satisfies ReplayCommandResult,
    };
  } catch (err) {
    const appErr = asAppError(err);
    return errorResponse(
      appErr.code,
      appErr.message,
      artifactPaths.size > 0 ? { artifactPaths: [...artifactPaths] } : undefined,
    );
  }
}

// fallow-ignore-next-line complexity
function buildReplayBuiltinVars(params: {
  req: DaemonRequest;
  sessionName: string;
  metadata: ReplayScriptMetadata;
  resolvedPath: string;
}): Record<string, string> {
  const { req, sessionName, metadata, resolvedPath } = params;
  const flags = req.flags ?? {};
  const cwd = req.meta?.cwd ?? process.cwd();
  const filename = path.relative(cwd, resolvedPath) || resolvedPath;
  const builtins: Record<string, string> = {
    AD_SESSION: sessionName,
    AD_FILENAME: filename,
  };
  const platform = (flags.platform as string | undefined) ?? metadata.platform;
  if (platform) builtins.AD_PLATFORM = platform;
  const target = (flags.target as string | undefined) ?? metadata.target;
  if (target) builtins.AD_TARGET = target;
  const device = flags.device;
  if (typeof device === 'string' && device.length > 0) builtins.AD_DEVICE = device;
  const deviceId = typeof flags.serial === 'string' ? flags.serial : flags.udid;
  if (typeof deviceId === 'string' && deviceId.length > 0) {
    builtins.AD_DEVICE_ID = deviceId;
  }
  if (typeof flags.shardIndex === 'number') {
    const shardIndex = String(flags.shardIndex);
    builtins.AD_SHARD_INDEX = shardIndex;
  }
  if (typeof flags.shardCount === 'number') builtins.AD_SHARD_COUNT = String(flags.shardCount);
  const artifactsDir = flags.artifactsDir;
  if (typeof artifactsDir === 'string' && artifactsDir.length > 0) {
    builtins.AD_ARTIFACTS = artifactsDir;
  }
  return builtins;
}

function emitReplayTestActionProgress(
  file: string,
  actionIndex: number,
  actionTotal: number,
  action: SessionAction,
): void {
  const progress = readReplayTestActionProgress();
  if (!progress) return;
  emitRequestProgress({
    type: 'replay-test',
    ...progress,
    file: progress.file || file,
    status: 'progress',
    stepIndex: actionIndex + 1,
    stepTotal: actionTotal,
    ...formatReplayTestActionProgress(action),
  });
}

function formatReplayTestActionProgress(
  action: SessionAction,
): Pick<ReplayTestProgressEvent, 'stepCommand' | 'stepValue'> {
  return {
    stepCommand: formatReplayTestProgressCommand(action.command),
    ...formatReplayTestProgressValue(action),
  };
}

function formatReplayTestProgressCommand(command: string): string {
  if (!command.startsWith('__maestro')) return command;
  const name = command.slice('__maestro'.length);
  return name.length > 0 ? name[0]!.toLowerCase() + name.slice(1) : command;
}

function formatReplayTestProgressValue(
  action: SessionAction,
): Pick<ReplayTestProgressEvent, 'stepValue'> {
  const positionals = action.positionals ?? [];
  const selectorValue = readSelectorDisplayValue(positionals[0]);
  if (selectorValue) return { stepValue: selectorValue };
  if (action.command === '__maestroTapPointPercent' && positionals.length >= 2) {
    return { stepValue: `${positionals[0]},${positionals[1]}%` };
  }
  if (positionals.length === 0) return {};
  return { stepValue: positionals.join(' ') };
}

function readSelectorDisplayValue(selector: string | undefined): string | undefined {
  if (!selector) return undefined;
  const parsed = tryParseSelectorChain(selector);
  if (!parsed) return undefined;
  const values = parsed.selectors.flatMap((entry) =>
    entry.terms.flatMap((term) =>
      (term.key === 'label' || term.key === 'text' || term.key === 'id') &&
      typeof term.value === 'string'
        ? [term.value]
        : [],
    ),
  );
  if (values.length === 0) return undefined;
  const first = values[0];
  return first && values.every((value) => value === first) ? first : undefined;
}

/**
 * ADR 0012 decision 6, R2: reject a fresh FULL replay on a session that
 * already carries a repair-run boundary — the session stays repair-armed
 * (`recordSession` remains true), so ANY full re-run re-appends the
 * already-recorded prefix (`session-action-recorder.ts` pushes
 * unconditionally), duplicating it in the healed slice. This fires REGARDLESS
 * of whether `--save-script` is passed this invocation (omitting the flag
 * does not disarm the session). A `--from` resume (`entryIndex > 0`)
 * legitimately continues the same armed run and is allowed.
 */
function preflightReplayAgainstActiveRepair(params: {
  entryIndex: number;
  sessionStore: SessionStore;
  sessionName: string;
}): DaemonResponse | undefined {
  const { entryIndex, sessionStore, sessionName } = params;
  if (entryIndex > 0) return undefined;
  if (sessionStore.get(sessionName)?.saveScriptBoundary === undefined) return undefined;
  return errorResponse(
    'INVALID_ARGS',
    'This session has an active --save-script repair run; continue it with replay --from <n> --plan-digest <sha256>, or finish with close, before starting a fresh full replay.',
  );
}

/**
 * ADR 0012 decision 6 (Fix 3): the source plan's own terminal `close` is
 * lifecycle, not a script step to replay, while a repair is armed — the agent
 * finalizes the transaction with `close --save-script` instead
 * (`session-close.ts`). Replaying the recorded `close` here would dispatch it
 * as an ordinary step: it tears the session down (and, absent Fix 1/2, could
 * even publish or diverge) before the agent gets that chance. Skipped exactly
 * like the `replay` pseudo-command just above it in the loop — never
 * dispatched, never divergence-checked, and (like that skip) not counted out
 * of `replayedCount`. Checked against session state, not this invocation's
 * own flags, matching R2: a repair stays armed across separate `--from` legs
 * regardless of whether `--save-script` is repeated on each one.
 */
function isRepairArmedTerminalClose(params: {
  action: SessionAction;
  index: number;
  totalActions: number;
  sessionStore: SessionStore;
  sessionName: string;
}): boolean {
  const { action, index, totalActions, sessionStore, sessionName } = params;
  if (action.command !== 'close') return false;
  if (index !== totalActions - 1) return false;
  return sessionStore.get(sessionName)?.saveScriptBoundary !== undefined;
}

/**
 * ADR 0012 decision 6, R1/R6: returns a per-step armer that sets
 * `recordSession` and stamps the repair-run boundary watermark ONCE. Absent
 * `--save-script` it is a no-op, so replay is byte-identical to today.
 */
function createReplaySaveScriptArmer(params: {
  saveScript: boolean | string | undefined;
  sessionStore: SessionStore;
  sessionName: string;
  sourcePath: string;
}): () => void {
  const { saveScript, sessionStore, sessionName, sourcePath } = params;
  if (!saveScript) return () => {};
  let firstArm = true;
  return () => {
    armReplaySaveScriptStep({ sessionStore, sessionName, saveScript, sourcePath, firstArm });
    firstArm = false;
  };
}

/**
 * Arms recording on the CURRENT session (a no-op until step 1 creates it) and
 * records the boundary watermark once. `firstArm` captures the pre-run action
 * count on the pre-loop session, so a reused session's earlier actions stay
 * excluded. A LATER arm reaching an unset boundary means step-1 `open`
 * REPLACED the session with a fresh `actions: []`
 * (`session-open-surface.ts:113-123`), so the replaced session is entirely
 * this run's — its boundary is 0, keeping the healed `open` in the slice
 * instead of amputating it. An explicit `<out>` always wins; absent one, the
 * healed script defaults to the `<original-stem>.healed.ad` sibling (R6).
 */
function armReplaySaveScriptStep(params: {
  sessionStore: SessionStore;
  sessionName: string;
  saveScript: boolean | string;
  sourcePath: string;
  firstArm: boolean;
}): void {
  const { sessionStore, sessionName, saveScript, sourcePath, firstArm } = params;
  const session = sessionStore.get(sessionName);
  if (!session) return;
  session.recordSession = true;
  if (typeof saveScript === 'string') {
    // An EXPLICIT `--save-script=<path>` clears the defaulted marker
    // (invariant: the marker is set iff the current `saveScriptPath` was
    // defaulted, not caller-directed). This no longer affects the publish
    // decision either way — the writer's refuse-on-exist guard is uniform
    // (`publishHealedScriptAtomically`) and refuses ANY pre-existing target,
    // an explicit caller-directed path included, exactly like the default
    // healed sibling.
    session.saveScriptPath = expandSessionPath(saveScript);
    session.saveScriptDefaultedHealedPath = false;
  } else if (session.saveScriptPath === undefined) {
    session.saveScriptPath = healedScriptSiblingPath(sourcePath);
    session.saveScriptDefaultedHealedPath = true;
  }
  if (session.saveScriptBoundary === undefined) {
    session.saveScriptBoundary = firstArm ? session.actions.length : 0;
  }
  // ADR 0012 decision 6, R7 (C5a): stash the original replay input so a reap
  // tombstone can hand back an actionable `replay <path> --save-script` re-run.
  if (session.repairSourcePath === undefined) session.repairSourcePath = sourcePath;
  sessionStore.set(sessionName, session);
}

/**
 * ADR 0012 decision 6, R7 (C1): stamps the `resume.repairSessionHeld` liveness
 * signal on a repair-armed divergence — the honest wire marker that the owning
 * session was kept live (this daemon never tears it down on a divergence) and
 * remains addressable for the corrective press + `replay --from`/`close`. Set
 * only when the session is genuinely held (armed): a plain non-repair
 * divergence, or one before step-1 `open` created/armed the session, gets no
 * signal (and no keep-alive). Never `false` — absent when not held.
 */
function markRepairSessionHeldIfArmed(params: {
  response: DaemonResponse;
  sessionStore: SessionStore;
  sessionName: string;
}): DaemonResponse {
  const { response, sessionStore, sessionName } = params;
  if (response.ok) return response;
  // The transaction is active iff the session is repair-armed and not yet
  // committed — the PERSISTED state, NOT this request's `--save-script` flag.
  // A `replay --from` continuation (which does not repeat `--save-script`, per
  // R2) is therefore still held on divergence and stays in the transaction.
  const session = sessionStore.get(sessionName);
  if (session?.saveScriptBoundary === undefined || session.saveScriptCommitted) return response;
  const resume = readDivergenceResumeRecord(response);
  if (resume) resume.repairSessionHeld = true;
  return response;
}

/** The mutable `details.divergence.resume` record on a failed response, or `undefined`. */
function readDivergenceResumeRecord(
  response: Extract<DaemonResponse, { ok: false }>,
): Record<string, unknown> | undefined {
  const divergence = response.error.details?.divergence;
  if (!divergence || typeof divergence !== 'object') return undefined;
  const resume = (divergence as Record<string, unknown>).resume;
  return resume && typeof resume === 'object' ? (resume as Record<string, unknown>) : undefined;
}

/** `flows/login.ad` -> `flows/login.healed.ad`, beside the original (R6). */
function healedScriptSiblingPath(sourcePath: string): string {
  const dir = path.dirname(sourcePath);
  const base = path.basename(sourcePath, path.extname(sourcePath));
  return path.join(dir, `${base}.healed.ad`);
}

function formatReplaySuccessMessage(replayed: number, wallClockMs: number): string {
  const seconds = (wallClockMs / 1000).toFixed(1);
  const noun = replayed === 1 ? 'step' : 'steps';
  return `Replayed ${replayed} ${noun} in ${seconds}s`;
}

// ADR 0012 step 4: a target-binding divergence is already a complete, final
// REPLAY_DIVERGENCE built from its own pre-action capture — distinguished from
// an action-failure divergence by its non-`action-failure` kind.
function isCompleteTargetBindingDivergenceResponse(response: DaemonResponse): boolean {
  if (response.ok || response.error.code !== 'REPLAY_DIVERGENCE') return false;
  const divergence = response.error.details?.divergence;
  const kind =
    divergence && typeof divergence === 'object'
      ? (divergence as Record<string, unknown>).kind
      : undefined;
  return typeof kind === 'string' && kind !== 'action-failure';
}

function readSessionSnapshotSampleCount(sessionStore: SessionStore, sessionName: string): number {
  return sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.length ?? 0;
}

function readSessionSnapshotSamplesSince(
  sessionStore: SessionStore,
  sessionName: string,
  start: number,
): SnapshotTimingSample[] {
  return sessionStore.get(sessionName)?.snapshotDiagnostics?.samples.slice(start) ?? [];
}
