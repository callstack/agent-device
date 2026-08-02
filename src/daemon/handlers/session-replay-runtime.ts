import fs from 'node:fs';
import { parseReplayInput } from '../../compat/replay-input.ts';
import { asAppError } from '@agent-device/kernel/errors';
import type {
  DaemonInvokeFn,
  DaemonRequest,
  DaemonResponse,
  SessionAction,
  SessionState,
} from '../types.ts';
import { SessionStore } from '../session-store.ts';
import { expandSessionPath } from '../session-paths.ts';
import { buildReplayScriptPlatformFlags } from '../replay-device-selection.ts';
import { computeReplayPlanDigest } from '../../replay/plan-digest.ts';
import { errorResponse, noActiveSessionError } from './response.ts';
import { invokeReplayAction } from './session-replay-action-runtime.ts';
import { tryParseSelectorChain } from '../../selectors/index.ts';
import type { ResponseLevel } from '@agent-device/kernel/contracts';
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
} from '@agent-device/contracts/capture';
import type { ReplayCommandResult, TargetAnnotationV1 } from '@agent-device/contracts/replay';
import {
  isMaestroYamlPath,
  maestroBackendRequiredMessage,
  resolveReplayFormat,
} from '../../replay/format.ts';
import { collectReplayActionArtifactPaths } from './session-replay-runtime-artifacts.ts';
import { withReplayFailureDiagnostics } from './session-replay-runtime-failure.ts';
import {
  buildReplayMetadataFlags,
  readEffectiveReplayPlanDigestMetadata,
  resolveReplayEntryIndex,
} from './session-replay-runtime-plan.ts';
import {
  buildReplayTargetGuardMismatchResponse,
  buildWaitLandmarkMismatchResponse,
  isReplayTargetGuardMismatchResponse,
  isWaitLandmarkMismatchResponse,
  verifyReplayActionTarget,
  type ReplayVerifiedTargetGuard,
} from './session-replay-target-verification.ts';
import { buildReplayBuiltinVars } from './session-replay-vars.ts';
import { runTypedMaestroReplayFile } from './session-replay-maestro-runtime.ts';
import type { ReplayTestAttemptStep, ReplayTestAttemptStepSink } from '@agent-device/replay-test';
import { getRequestSignal } from '../../request/cancel.ts';
import {
  NO_SCRIPT_PUBLICATION,
  scriptTargetForce,
  scriptTargetPath,
  type SessionScriptPublicationState,
} from '../session-script-publication-state.ts';
import {
  createReplayCoordinator,
  healedScriptSiblingPath,
  type ReplayCoordinator,
} from '../session-replay-coordinator.ts';

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
  signal: AbortSignal | undefined;
  /** #1478 P4b: the one locked gateway to this request's repair transaction. */
  coordinator: ReplayCoordinator;
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
    resumeStamper: ctx.coordinator.resumeStamper,
    logPath: ctx.logPath,
    artifactPaths,
    responseLevel: ctx.responseLevel,
    planActions: ctx.actions,
    planDigest: ctx.planDigest,
    signal: ctx.signal,
  });
  if (!verification.verified) return verification.response;
  const guard = verification.guard;
  const deferredLandmark = verification.deferredLandmark;
  const guardInternal = guard
    ? { replayTargetGuard: guard.expected }
    : deferredLandmark
      ? { replayLandmarkGuard: deferredLandmark }
      : undefined;
  const guardedReq = guardInternal
    ? { ...ctx.replayReq, internal: { ...ctx.replayReq.internal, ...guardInternal } }
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
  return await convertIdentityRefusalResponse({
    ctx,
    action,
    index,
    artifactPaths,
    sourcePath,
    sourceLine,
    response,
    guard,
    deferredLandmark,
  });
}

/**
 * Converts a dispatch-time identity refusal — the post-resolution guard
 * mismatch, or wait's landmark timeout — into its identity-mismatch
 * divergence; every other response passes through unchanged.
 */
async function convertIdentityRefusalResponse(params: {
  ctx: ReplayStepContext;
  action: SessionAction;
  index: number;
  artifactPaths: string[];
  sourcePath: string;
  sourceLine: number;
  response: DaemonResponse;
  guard: ReplayVerifiedTargetGuard | undefined;
  deferredLandmark: TargetAnnotationV1 | undefined;
}): Promise<DaemonResponse> {
  const { ctx, action, index, artifactPaths, sourcePath, sourceLine, response } = params;
  const mismatchParams = {
    action,
    scope: ctx.scope,
    failedResponse: response,
    sourcePath,
    sourceLine,
    replayPath: ctx.resolved,
    step: index + 1,
    sessionName: ctx.sessionName,
    sessionStore: ctx.sessionStore,
    resumeStamper: ctx.coordinator.resumeStamper,
    logPath: ctx.logPath,
    artifactPaths,
    responseLevel: ctx.responseLevel,
    planActions: ctx.actions,
    planDigest: ctx.planDigest,
    signal: ctx.signal,
  };
  if (params.guard && isReplayTargetGuardMismatchResponse(response)) {
    return await buildReplayTargetGuardMismatchResponse({ ...mismatchParams, guard: params.guard });
  }
  if (params.deferredLandmark && isWaitLandmarkMismatchResponse(response)) {
    return await buildWaitLandmarkMismatchResponse(mismatchParams);
  }
  return response;
}

export async function runReplayScriptFile(params: {
  req: DaemonRequest;
  sessionName: string;
  logPath: string;
  sessionStore: SessionStore;
  tracePath?: string;
  /**
   * Per-attempt step sink supplied by the replay-test scheduler through its host (#1478 P3).
   * Threaded alongside `tracePath` rather than read from request-global storage, so a direct
   * `replay` simply has no sink and emits nothing.
   */
  onStep?: ReplayTestAttemptStepSink;
  invoke: DaemonInvokeFn;
}): Promise<DaemonResponse> {
  const { req, sessionName, logPath, sessionStore, tracePath, onStep, invoke } = params;
  const filePath = req.positionals?.[0];
  if (!filePath) {
    return errorResponse('INVALID_ARGS', 'replay requires a path');
  }

  const startedAt = Date.now();
  let resolved = '';
  const artifactPaths = new Set<string>();
  // #1478 P4b: the one locked coordinator this request reaches the repair
  // transaction and resume watermark through.
  const coordinator = createReplayCoordinator({ sessionStore, sessionName });
  try {
    resolved = SessionStore.expandHome(filePath, req.meta?.cwd);
    if (isMaestroYamlPath(resolved) && req.flags?.replayBackend !== 'maestro') {
      return errorResponse('INVALID_ARGS', maestroBackendRequiredMessage('replay', filePath));
    }
    if (resolveReplayFormat(resolved, req.flags?.replayBackend) === 'maestro') {
      if (coordinator.view()?.repairBoundary !== undefined) {
        return errorResponse(
          'INVALID_ARGS',
          'This session has an active .ad --save-script repair run; finish it with replay --from or close before running Maestro YAML.',
        );
      }
      return await runTypedMaestroReplayFile(params);
    }
    const planPreparation = prepareReplayPlan({
      req,
      sessionName,
      sessionStore,
      tracePath,
      resolved,
      coordinator,
    });
    if (!planPreparation.ok) return planPreparation.response;
    const {
      replayReq,
      actions,
      actionLines,
      actionSourcePaths,
      planDigest,
      entryIndex,
      scope,
      actionTracePath,
      snapshotDiagnosticSamples,
    } = planPreparation.value;
    const sessionPreparation = prepareReplaySession({
      req,
      entryIndex,
      sessionStore,
      sessionName,
      sourcePath: resolved,
      coordinator,
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
      signal: getRequestSignal(req.meta?.requestId),
      coordinator,
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
      onStep,
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
      coordinator,
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
  onStep: ReplayTestAttemptStepSink | undefined;
  armSaveScript: () => void;
};

async function executeReplayActions(
  params: ReplayActionExecution,
): Promise<DaemonResponse | undefined> {
  const {
    sessionName,
    sessionStore,
    actions,
    entryIndex,
    stepContext,
    artifactPaths,
    snapshotDiagnosticSamples,
    onStep,
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
        coordinator: stepContext.coordinator,
      })
    ) {
      continue;
    }
    onStep?.(replayActionStep(index, actions.length, action));
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
    params.stepContext.coordinator.markSessionHeldIfArmed(failure);
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
      resumeStamper: params.stepContext.coordinator.resumeStamper,
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
  coordinator: ReplayCoordinator;
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
    coordinator,
  } = params;
  armSaveScript();
  coordinator.markCompleteIfArmed();
  const completedSession = sessionStore.get(sessionName);
  const replayedCount = actions.length - entryIndex;
  const snapshotDiagnosticsSummary = summarizeSnapshotTimingSamples(snapshotDiagnosticSamples);
  return {
    ok: true,
    data: {
      replayed: replayedCount,
      healed: 0,
      session: sessionName,
      sessionActive: completedSession !== undefined,
      artifactPaths: [...artifactPaths],
      ...(snapshotDiagnosticsSummary ? { snapshotDiagnostics: snapshotDiagnosticsSummary } : {}),
      message: formatReplaySuccessMessage(replayedCount, Date.now() - startedAt),
    } satisfies ReplayCommandResult,
  };
}

function replayActionStep(
  actionIndex: number,
  actionTotal: number,
  action: SessionAction,
): ReplayTestAttemptStep {
  return {
    index: actionIndex + 1,
    total: actionTotal,
    command: action.command,
    ...replayActionStepValue(action),
  };
}

function replayActionStepValue(action: SessionAction): Pick<ReplayTestAttemptStep, 'value'> {
  const positionals = action.positionals ?? [];
  const selectorValue = readSelectorDisplayValue(positionals[0]);
  if (selectorValue) return { value: selectorValue };
  if (positionals.length === 0) return {};
  return { value: positionals.join(' ') };
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

function prepareReplayPlan(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  tracePath: string | undefined;
  resolved: string;
  coordinator: ReplayCoordinator;
}): { ok: true; value: PreparedReplayPlan } | { ok: false; response: DaemonResponse } {
  const { req, sessionName, sessionStore, tracePath, resolved, coordinator } = params;
  const parsedResult = parseReplayScript(resolved, req);
  if (!parsedResult.ok) return parsedResult;
  const parsed = parsedResult.value;
  const { metadata, actions, actionLines, actionSourcePaths } = parsed;
  const replayReq = applyReplayMetadata(
    { ...req, flags: buildReplayScriptPlatformFlags(req.flags, actions) },
    metadata,
  );
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
    coordinator.view()?.pendingRecordAndHeal,
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
  sessionStore: SessionStore;
  sessionName: string;
  sourcePath: string;
  coordinator: ReplayCoordinator;
}): { ok: true; armSaveScript: () => void } | { ok: false; response: DaemonResponse } {
  const { req, entryIndex, sessionStore, sessionName, sourcePath, coordinator } = params;
  const sessionPreflight = validateReplaySessionEntry({
    entryIndex,
    sessionStore,
    sessionName,
    coordinator,
  });
  if (sessionPreflight) return { ok: false, response: sessionPreflight };

  consumeReplayResumeState({ req, coordinator });
  return prepareSaveScriptSession({ req, sessionStore, sessionName, sourcePath, coordinator });
}

function validateReplaySessionEntry(params: {
  entryIndex: number;
  sessionStore: SessionStore;
  sessionName: string;
  coordinator: ReplayCoordinator;
}): DaemonResponse | undefined {
  const repairPreflight = preflightReplayAgainstActiveRepair(params);
  if (repairPreflight) return repairPreflight;
  if (params.entryIndex > 0 && !params.sessionStore.get(params.sessionName)) {
    return noActiveSessionError();
  }
  return undefined;
}

/**
 * Rejects arming a repair over an ordinary authoring recording (R2's disjointness) and runs the
 * arm-time EEXIST preflight against the target this request resolves to.
 */
function rejectSaveScriptArming(params: {
  saveScript: boolean | string | undefined;
  force: boolean | undefined;
  preRunState: SessionScriptPublicationState;
  sourcePath: string;
}): DaemonResponse | undefined {
  const { saveScript, force, preRunState, sourcePath } = params;
  if (saveScript && preRunState.kind === 'authoring') {
    return errorResponse(
      'INVALID_ARGS',
      `replay --save-script cannot re-arm an ordinary recording in terminal/active state ${preRunState.status}. Close this session and use a fresh one for repair authoring.`,
    );
  }
  return preflightSaveScriptTarget({
    saveScript,
    liveForce: force,
    persistedForce: scriptTargetForce(preRunState) || undefined,
    sourcePath,
    existingSaveScriptPath: scriptTargetPath(preRunState),
  });
}

function prepareSaveScriptSession(params: {
  req: DaemonRequest;
  sessionStore: SessionStore;
  sessionName: string;
  sourcePath: string;
  coordinator: ReplayCoordinator;
}): { ok: true; armSaveScript: () => void } | { ok: false; response: DaemonResponse } {
  const { req, sessionStore, sessionName, sourcePath, coordinator } = params;
  const preRunSession = sessionStore.get(sessionName);
  const { saveScript, force } = req.flags ?? {};
  const rejection = rejectSaveScriptArming({
    saveScript,
    force,
    preRunState: preRunSession?.scriptPublication ?? NO_SCRIPT_PUBLICATION,
    sourcePath,
  });
  if (rejection) return { ok: false, response: rejection };

  coordinator.demoteForRerunIfArmed();
  return {
    ok: true,
    armSaveScript: createReplaySaveScriptArmer({
      saveScript,
      force,
      coordinator,
      sourcePath,
    }),
  };
}

function consumeReplayResumeState(params: {
  req: DaemonRequest;
  coordinator: ReplayCoordinator;
}): void {
  const { req, coordinator } = params;
  coordinator.clearCorrectiveWatermarkIfExpected(req.flags?.replayFrom);
  if (req.flags?.saveScript) coordinator.clearTombstone();
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
  coordinator: ReplayCoordinator;
}): DaemonResponse | undefined {
  const { entryIndex, coordinator } = params;
  if (entryIndex > 0) return undefined;
  if (coordinator.view()?.repairBoundary === undefined) return undefined;
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
 * the coordinator's `armStep` would (explicit `--save-script=<path>` always
 * wins; otherwise an already-armed session's existing path if this is a
 * `--from` continuation leg reusing it, else the default `<stem>.healed.ad`
 * sibling) WITHOUT needing the session to exist yet, so it runs before step 1
 * dispatches even when that step is the `open` that creates the session.
 * READ-ONLY: it never mutates the session (it runs before
 * `resolveScriptTarget`).
 *
 * The effective-force decision MATCHES `resolveScriptTarget`'s per-target
 * contract, computed against the target THIS request resolves to: a live
 * `--force`/`--overwrite` always bypasses; a PERSISTED per-target grant
 * bypasses ONLY when this request writes to the SAME target it was granted for
 * (`targetPath === existingSaveScriptPath`). An explicit RETARGET to a
 * different path without a live force does NOT bypass here — because
 * `resolveScriptTarget` will CLEAR that persisted force for the new target
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
  coordinator: ReplayCoordinator;
}): boolean {
  const { action, index, totalActions, coordinator } = params;
  if (action.command !== 'close') return false;
  if (index !== totalActions - 1) return false;
  return coordinator.view()?.repairBoundary !== undefined;
}

/**
 * ADR 0012 decision 6, R1/R6: returns a per-step armer that sets
 * `recordSession` and stamps the repair-run boundary watermark ONCE, through
 * the request's `ReplayCoordinator` (#1478 P4b). Absent `--save-script` it is
 * a no-op, so replay is byte-identical to today.
 */
function createReplaySaveScriptArmer(params: {
  saveScript: boolean | string | undefined;
  force: boolean | undefined;
  coordinator: ReplayCoordinator;
  sourcePath: string;
}): () => void {
  const { saveScript, force, coordinator, sourcePath } = params;
  if (!saveScript) return () => {};
  let firstArm = true;
  return () => {
    coordinator.armStep({ saveScript, force, sourcePath, firstArm });
    firstArm = false;
  };
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
