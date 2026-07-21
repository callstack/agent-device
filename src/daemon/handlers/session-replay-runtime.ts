import fs from 'node:fs';
import path from 'node:path';
import { parseReplayInput } from '../../compat/replay-input.ts';
import { asAppError } from '../../kernel/errors.ts';
import type {
  DaemonInvokeFn,
  DaemonRequest,
  DaemonResponse,
  SessionAction,
  SessionState,
} from '../types.ts';
import {
  emitRequestProgress,
  readReplayTestActionProgress,
  type ReplayTestProgressEvent,
} from '../../request/progress.ts';
import { SessionStore } from '../session-store.ts';
import { expandSessionPath } from '../session-paths.ts';
import { applySaveScriptRetarget } from '../session-action-recorder.ts';
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
import type { ReplayDivergenceResume } from '../../replay/divergence.ts';
import { isRecord } from '../../utils/parsing.ts';
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
import { buildReplayBuiltinVars } from './session-replay-vars.ts';
import {
  isTypedMaestroReplay,
  runTypedMaestroReplayFile,
} from './session-replay-maestro-runtime.ts';

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
    const typedResponse = await runTypedReplayIfNeeded({ ...params, resolved });
    if (typedResponse) return typedResponse;
    const planPreparation = prepareReplayPlan({
      req,
      sessionName,
      sessionStore,
      tracePath,
      resolved,
    });
    if (!planPreparation.ok) return planPreparation.response;
    const {
      replayReq,
      actions,
      actionLines,
      actionSourcePaths,
      planDigest,
      preEntrySession,
      entryIndex,
      scope,
      actionTracePath,
      snapshotDiagnosticSamples,
    } = planPreparation.value;
    const sessionPreparation = prepareReplaySession({
      req,
      entryIndex,
      preEntrySession,
      sessionStore,
      sessionName,
      sourcePath: resolved,
    });
    if (!sessionPreparation.ok) return sessionPreparation.response;
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
    const failure = await executeReplayActions({
      req,
      sessionName,
      sessionStore,
      logPath,
      resolved,
      actions,
      actionLines,
      actionSourcePaths,
      planDigest,
      entryIndex,
      scope,
      stepContext,
      artifactPaths,
      snapshotDiagnosticSamples,
      armSaveScript: sessionPreparation.armSaveScript,
    });
    if (failure) return failure;
    return completeReplayRun({
      startedAt,
      sessionName,
      sessionStore,
      actions,
      entryIndex,
      artifactPaths,
      snapshotDiagnosticSamples,
      armSaveScript: sessionPreparation.armSaveScript,
    });
  } catch (err) {
    const appErr = asAppError(err);
    return errorResponse(
      appErr.code,
      appErr.message,
      artifactPaths.size > 0 ? { artifactPaths: [...artifactPaths] } : undefined,
    );
  }
}

type ReplayActionExecution = {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
  resolved: string;
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths: (string | undefined)[] | undefined;
  planDigest: string;
  entryIndex: number;
  scope: ReplayVarScope;
  stepContext: ReplayStepContext;
  artifactPaths: Set<string>;
  snapshotDiagnosticSamples: SnapshotTimingSample[];
  armSaveScript: () => void;
};

async function executeReplayActions(
  params: ReplayActionExecution,
): Promise<DaemonResponse | undefined> {
  const {
    sessionName,
    sessionStore,
    resolved,
    actions,
    entryIndex,
    stepContext,
    artifactPaths,
    snapshotDiagnosticSamples,
    armSaveScript,
  } = params;
  for (let index = entryIndex; index < actions.length; index += 1) {
    const action = actions[index];
    if (!isExecutableReplayAction(action)) continue;
    // Arm before checking terminal close so `[open, close]` records the
    // session created by `open` before treating `close` as lifecycle.
    armSaveScript();
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
    if (response.ok) continue;
    return await buildReplayActionFailure(params, action, index, response);
  }
  return undefined;
}

function isExecutableReplayAction(action: SessionAction | undefined): action is SessionAction {
  return Boolean(action && action.command !== 'replay');
}

async function buildReplayActionFailure(
  params: ReplayActionExecution,
  action: SessionAction,
  index: number,
  response: Extract<DaemonResponse, { ok: false }>,
): Promise<DaemonResponse> {
  const heldResponse = (failure: DaemonResponse): DaemonResponse =>
    markRepairSessionHeldIfArmed({
      response: failure,
      sessionStore: params.sessionStore,
      sessionName: params.sessionName,
    });
  if (isCompleteTargetBindingDivergenceResponse(response)) return heldResponse(response);
  return heldResponse(
    await withReplayFailureDiagnostics({
      response,
      action,
      index,
      replayPath: params.resolved,
      sourcePath: params.actionSourcePaths?.[index] ?? params.resolved,
      sourceLine: params.actionLines[index] ?? 1,
      artifactPaths: [...params.artifactPaths],
      snapshotDiagnosticSamples: params.snapshotDiagnosticSamples,
      scope: params.scope,
      req: params.req,
      sessionName: params.sessionName,
      sessionStore: params.sessionStore,
      logPath: params.logPath,
      planActions: params.actions,
      planDigest: params.planDigest,
    }),
  );
}

function completeReplayRun(params: {
  startedAt: number;
  sessionName: string;
  sessionStore: SessionStore;
  actions: SessionAction[];
  entryIndex: number;
  artifactPaths: Set<string>;
  snapshotDiagnosticSamples: SnapshotTimingSample[];
  armSaveScript: () => void;
}): DaemonResponse {
  const {
    startedAt,
    sessionName,
    sessionStore,
    actions,
    entryIndex,
    artifactPaths,
    snapshotDiagnosticSamples,
    armSaveScript,
  } = params;
  armSaveScript();
  const completedSession = sessionStore.get(sessionName);
  if (completedSession?.saveScriptBoundary !== undefined) {
    completedSession.saveScriptComplete = true;
    sessionStore.set(sessionName, completedSession);
  }
  const replayedCount = actions.length - entryIndex;
  const snapshotDiagnosticsSummary = summarizeSnapshotTimingSamples(snapshotDiagnosticSamples);
  return {
    ok: true,
    data: {
      replayed: replayedCount,
      healed: 0,
      session: sessionName,
      artifactPaths: [...artifactPaths],
      ...(snapshotDiagnosticsSummary ? { snapshotDiagnostics: snapshotDiagnosticsSummary } : {}),
      message: formatReplaySuccessMessage(replayedCount, Date.now() - startedAt),
    } satisfies ReplayCommandResult,
  };
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
    stepCommand: action.command,
    ...formatReplayTestProgressValue(action),
  };
}

function formatReplayTestProgressValue(
  action: SessionAction,
): Pick<ReplayTestProgressEvent, 'stepValue'> {
  const positionals = action.positionals ?? [];
  const selectorValue = readSelectorDisplayValue(positionals[0]);
  if (selectorValue) return { stepValue: selectorValue };
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

type PreparedReplayPlan = {
  replayReq: DaemonRequest;
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths: (string | undefined)[] | undefined;
  planDigest: string;
  preEntrySession: SessionState | undefined;
  entryIndex: number;
  scope: ReplayVarScope;
  actionTracePath: string | undefined;
  snapshotDiagnosticSamples: SnapshotTimingSample[];
};

type ParsedReplayInput = ReturnType<typeof parseReplayInput>;

async function runTypedReplayIfNeeded(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  tracePath?: string;
  invoke: DaemonInvokeFn;
  resolved: string;
}): Promise<DaemonResponse | undefined> {
  if (!isTypedMaestroReplay(params.req, params.resolved)) return undefined;
  if (params.sessionStore.get(params.sessionName)?.saveScriptBoundary !== undefined) {
    return errorResponse(
      'INVALID_ARGS',
      'This session has an active .ad --save-script repair run; finish it with replay --from or close before running Maestro YAML.',
    );
  }
  return await runTypedMaestroReplayFile(params);
}

function prepareReplayPlan(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  tracePath: string | undefined;
  resolved: string;
}): { ok: true; value: PreparedReplayPlan } | { ok: false; response: DaemonResponse } {
  const { req, sessionName, sessionStore, tracePath, resolved } = params;
  const parsedResult = parseReplayScript(resolved, req);
  if (!parsedResult.ok) return parsedResult;
  const parsed = parsedResult.value;
  const { metadata, actions, actionLines, actionSourcePaths } = parsed;
  const replayReq = applyReplayMetadata(req, metadata);
  const planDigest = computeReplayPlanDigest({
    actions,
    actionLines,
    actionSourcePaths,
    metadata: readEffectiveReplayPlanDigestMetadata(replayReq.flags),
  });
  const preEntrySession = sessionStore.get(sessionName);
  const entryIndex = resolveReplayEntryIndex(
    req.flags,
    actions.length,
    planDigest,
    preEntrySession?.pendingRecordAndHeal,
    preEntrySession?.actions.length ?? 0,
  );
  if (!entryIndex.ok) return entryIndex;

  return {
    ok: true,
    value: {
      replayReq,
      actions,
      actionLines,
      actionSourcePaths,
      planDigest,
      preEntrySession,
      entryIndex: entryIndex.value,
      scope: buildPreparedReplayScope({ req, replayReq, sessionName, resolved, metadata }),
      actionTracePath: tracePath ?? preEntrySession?.trace?.outPath,
      snapshotDiagnosticSamples: [],
    },
  };
}

function parseReplayScript(
  resolved: string,
  req: DaemonRequest,
): { ok: true; value: ParsedReplayInput } | { ok: false; response: DaemonResponse } {
  const script = fs.readFileSync(resolved, 'utf8');
  const firstNonWhitespace = script.trimStart()[0];
  if (firstNonWhitespace !== '{' && firstNonWhitespace !== '[') {
    return { ok: true, value: parseReplayInput(script, req.flags) };
  }
  return {
    ok: false,
    response: errorResponse(
      'INVALID_ARGS',
      'replay accepts .ad script files. JSON replay payloads are no longer supported.',
    ),
  };
}

function applyReplayMetadata(
  req: DaemonRequest,
  metadata: ParsedReplayInput['metadata'],
): DaemonRequest {
  if (!metadata.platform && !metadata.target) return req;
  return { ...req, flags: buildReplayMetadataFlags(req.flags, metadata) };
}

function buildPreparedReplayScope(params: {
  req: DaemonRequest;
  replayReq: DaemonRequest;
  sessionName: string;
  resolved: string;
  metadata: ParsedReplayInput['metadata'];
}): ReplayVarScope {
  const { req, replayReq, sessionName, resolved, metadata } = params;
  return buildReplayVarScope({
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
}

function prepareReplaySession(params: {
  req: DaemonRequest;
  entryIndex: number;
  preEntrySession: SessionState | undefined;
  sessionStore: SessionStore;
  sessionName: string;
  sourcePath: string;
}): { ok: true; armSaveScript: () => void } | { ok: false; response: DaemonResponse } {
  const { req, entryIndex, preEntrySession, sessionStore, sessionName, sourcePath } = params;
  const sessionPreflight = validateReplaySessionEntry({
    entryIndex,
    sessionStore,
    sessionName,
  });
  if (sessionPreflight) return { ok: false, response: sessionPreflight };

  consumeReplayResumeState({ req, preEntrySession, sessionStore, sessionName });
  return prepareSaveScriptSession({ req, sessionStore, sessionName, sourcePath });
}

function validateReplaySessionEntry(params: {
  entryIndex: number;
  sessionStore: SessionStore;
  sessionName: string;
}): DaemonResponse | undefined {
  const repairPreflight = preflightReplayAgainstActiveRepair(params);
  if (repairPreflight) return repairPreflight;
  if (params.entryIndex > 0 && !params.sessionStore.get(params.sessionName)) {
    return noActiveSessionError();
  }
  return undefined;
}

function prepareSaveScriptSession(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  sessionName: string;
  sourcePath: string;
}): { ok: true; armSaveScript: () => void } | { ok: false; response: DaemonResponse } {
  const { req, sessionStore, sessionName, sourcePath } = params;
  const preRunSession = sessionStore.get(sessionName);
  const { saveScript, force } = req.flags ?? {};
  const {
    saveScriptForce: persistedForce,
    saveScriptPath: existingSaveScriptPath,
    saveScriptBoundary,
  } = preRunSession ?? {};
  if (saveScript && preRunSession?.scriptRecordingState !== undefined) {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        `replay --save-script cannot re-arm an ordinary recording in terminal/active state ${preRunSession.scriptRecordingState}. Close this session and use a fresh one for repair authoring.`,
      ),
    };
  }
  const saveScriptPreflight = preflightSaveScriptTarget({
    saveScript,
    liveForce: force,
    persistedForce,
    sourcePath,
    existingSaveScriptPath,
  });
  if (saveScriptPreflight) return { ok: false, response: saveScriptPreflight };

  if (preRunSession && saveScriptBoundary !== undefined) preRunSession.saveScriptComplete = false;
  return {
    ok: true,
    armSaveScript: createReplaySaveScriptArmer({
      saveScript,
      force,
      sessionStore,
      sessionName,
      sourcePath,
    }),
  };
}

function consumeReplayResumeState(params: {
  req: DaemonRequest;
  preEntrySession: SessionState | undefined;
  sessionStore: SessionStore;
  sessionName: string;
}): void {
  const { req, preEntrySession, sessionStore, sessionName } = params;
  if (
    preEntrySession &&
    preEntrySession.pendingRecordAndHeal?.expectedFrom === req.flags?.replayFrom
  ) {
    preEntrySession.pendingRecordAndHeal = undefined;
    sessionStore.set(sessionName, preEntrySession);
  }
  if (req.flags?.saveScript) sessionStore.clearRepairTombstone(sessionName);
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
 * #1258: arm-time EEXIST preflight. Absent this, a repair-armed run's target
 * is only checked at PUBLISH time (`publishHealedScriptAtomically`, on
 * `close`/completion) — by then the ENTIRE repair (agent's corrective steps
 * included) may already have executed against the device, only to fail on a
 * pre-existing target at the very end. Resolves the SAME target
 * `armReplaySaveScriptStep` would (explicit `--save-script=<path>` always
 * wins; otherwise an already-armed session's existing path if this is a
 * `--from` continuation leg reusing it, else the default `<stem>.healed.ad`
 * sibling) WITHOUT needing the session to exist yet, so it runs before step 1
 * dispatches even when that step is the `open` that creates the session.
 * READ-ONLY: it never mutates the session (it runs before
 * `applySaveScriptRetarget`).
 *
 * The effective-force decision MATCHES `applySaveScriptRetarget`'s per-target
 * contract, computed against the target THIS request resolves to: a live
 * `--force`/`--overwrite` always bypasses; a PERSISTED `saveScriptForce`
 * bypasses ONLY when this request writes to the SAME target it was granted for
 * (`targetPath === existingSaveScriptPath`). An explicit RETARGET to a
 * different path without a live force does NOT bypass here — because
 * `applySaveScriptRetarget` will CLEAR that persisted force for the new target
 * before publication anyway, so letting the run execute (mutating the session
 * mid-flight) only to refuse the existing target at the end is exactly what
 * this preflight exists to prevent. A no-op when `--save-script` was not passed.
 */
function preflightSaveScriptTarget(params: {
  saveScript: boolean | string | undefined;
  liveForce: boolean | undefined;
  persistedForce: boolean | undefined;
  sourcePath: string;
  existingSaveScriptPath: string | undefined;
}): DaemonResponse | undefined {
  const { saveScript, liveForce, persistedForce, sourcePath, existingSaveScriptPath } = params;
  if (!saveScript) return undefined;
  const targetPath =
    typeof saveScript === 'string'
      ? expandSessionPath(saveScript)
      : (existingSaveScriptPath ?? healedScriptSiblingPath(sourcePath));
  const effectiveForce =
    Boolean(liveForce) || (Boolean(persistedForce) && targetPath === existingSaveScriptPath);
  if (effectiveForce) return undefined;
  if (!fs.existsSync(targetPath)) return undefined;
  return errorResponse(
    'COMMAND_FAILED',
    `A file already exists at ${targetPath}; remove it, pass replay --save-script=<other-path>, or pass --force/--overwrite to replace it.`,
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
  force: boolean | undefined;
  sessionStore: SessionStore;
  sessionName: string;
  sourcePath: string;
}): () => void {
  const { saveScript, force, sessionStore, sessionName, sourcePath } = params;
  if (!saveScript) return () => {};
  let firstArm = true;
  return () => {
    armReplaySaveScriptStep({ sessionStore, sessionName, saveScript, force, sourcePath, firstArm });
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
  force: boolean | undefined;
  sourcePath: string;
  firstArm: boolean;
}): void {
  const { sessionStore, sessionName, saveScript, force, sourcePath, firstArm } = params;
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
    applySaveScriptRetarget(session, expandSessionPath(saveScript), force);
    session.saveScriptDefaultedHealedPath = false;
  } else if (session.saveScriptPath === undefined) {
    session.saveScriptPath = healedScriptSiblingPath(sourcePath);
    session.saveScriptDefaultedHealedPath = true;
  }
  // #1258: force is per-target — a LIVE `--force`/`--overwrite` persists onto
  // the session (`saveScriptForce`) so a LATER `--from` continuation leg or an
  // unattended auto-commit teardown (no live request) still honors it. Set
  // AFTER `applySaveScriptRetarget` so a live flag always wins over a
  // retarget-clear.
  if (force) session.saveScriptForce = true;
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
): ReplayDivergenceResume | undefined {
  const divergence = response.error.details?.divergence;
  if (!isRecord(divergence) || !isReplayDivergenceResume(divergence.resume)) return undefined;
  return divergence.resume;
}

function isReplayDivergenceResume(value: unknown): value is ReplayDivergenceResume {
  if (!isRecord(value) || typeof value.allowed !== 'boolean') return false;
  if (!Number.isInteger(value.from) || typeof value.planDigest !== 'string') return false;
  return value.allowed || typeof value.reason === 'string';
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
