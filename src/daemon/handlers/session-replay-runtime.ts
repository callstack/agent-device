import fs from 'node:fs';
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
import { errorResponse, noActiveSessionError } from './response.ts';
import { invokeReplayAction } from './session-replay-action-runtime.ts';
import {
  createDaemonReplaySelectorPort,
  readReplaySelectorDisplayValue,
} from '../replay-selector-port.ts';
import type { ResponseLevel } from '@agent-device/kernel/contracts';
import {
  formatReplaySuccessMessage,
  inspectAdReplay,
  runAdReplay,
  type AdReplayManifest,
  type AdReplayStepFailure,
  type AdReplayStepRuntime,
  type ReplaySelectorPort,
} from '@agent-device/ad-replay';
import {
  buildReplayVarScope,
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
  type ReplayVarScope,
} from '@agent-device/ad-script';
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
import { buildReplayMetadataFlags } from './session-replay-runtime-plan.ts';
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
import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';
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
import {
  countExecutedReplayActions,
  isExecutableReplayAction,
  requireLiveSessionForKeepSession,
  resolveSuppressedTerminalCloseIndex,
} from './session-replay-terminal-lifecycle.ts';

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
  /** #1478 P5 stage C: the one selector-port instance this request threads through the divergence-report chain. */
  port: ReplaySelectorPort;
};

/**
 * ADR 0012 migration step 4: verify the recorded target BEFORE sending the
 * device action. A non-verified outcome is a complete target-binding
 * REPLAY_DIVERGENCE (built from its own pre-action capture); only a verified
 * outcome dispatches, carrying the verified member's identity as a
 * post-resolution guard so dispatch's own resolution (occlusion/visibility
 * guards verification does not replicate) must land on the SAME element or
 * refuse pre-action.
 *
 * #1478 P5 stage C2b: this is the daemon's `AdReplayStepRuntime.executeStep`
 * implementation — capture, the single dispatch site, and post-resolution
 * guard/landmark conversion are all daemon authority, so the engine step loop
 * (`runAdReplay`, `@agent-device/ad-replay`) calls this as one opaque
 * capability and never sees any of it.
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
    port: ctx.port,
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
    port: ctx.port,
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
  const keepSession = req.flags?.replayKeepSession === true;
  let resolved = '';
  // Mirrors whatever the engine step loop's own `collectArtifactPaths`
  // capability accumulates (see `createAdReplayStepRuntime`), so a mid-loop
  // exception still reports the artifacts collected up to that point.
  const artifactPaths = new Set<string>();
  // #1478 P4b: the one locked coordinator this request reaches the repair
  // transaction and resume watermark through.
  const coordinator = createReplayCoordinator({ sessionStore, sessionName });
  // #1478 P5 stage C: the one selector-port instance this request threads
  // through the divergence-report chain (verification, classification,
  // suggestion building) — never a second-constructed adapter.
  const port = createDaemonReplaySelectorPort();
  try {
    resolved = SessionStore.expandHome(filePath, req.meta?.cwd);
    if (isMaestroYamlPath(resolved) && req.flags?.replayBackend !== 'maestro') {
      return errorResponse('INVALID_ARGS', maestroBackendRequiredMessage('replay', filePath));
    }
    if (resolveReplayFormat(resolved, req.flags?.replayBackend) === 'maestro') {
      if (keepSession) {
        return errorResponse(
          'INVALID_ARGS',
          '--keep-session is supported only for native .ad replay; Maestro YAML owns its lifecycle.',
        );
      }
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
      keepSession,
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
      port,
    };
    const { runtime, readLastResponse } = createAdReplayStepRuntime({
      ctx: stepContext,
      req,
      artifactPaths,
      onStep,
      armSaveScript: sessionPreparation.armSaveScript,
      suppressedTerminalCloseIndex,
    });
    const outcome = await runAdReplay({ actions, entryIndex }, runtime);
    if (outcome.status === 'failed') {
      // #1555 P1 (neutral outcomes): `runAdReplay` never holds or returns a
      // `DaemonResponse` — it only reports WHICH step failed. The real wire
      // response was built (and wrapped with diagnostics/repair-hold marking)
      // by this adapter's own `executeStep`/`handleActionFailure`, which
      // stashed it in `readLastResponse`'s closure as it went; reading it
      // back here is what makes the final response byte-identical to the
      // pre-split code that threaded it straight through the engine's return
      // value. The fallback below is unreachable in practice (`executeStep`
      // always records a response before any failure can be reported) and
      // exists only so this stays total.
      return (
        readLastResponse() ??
        errorResponse('COMMAND_FAILED', 'replay step failed with no recorded response')
      );
    }
    return completeReplayRun({
      startedAt,
      sessionName,
      sessionStore,
      replayed: outcome.replayed,
      artifactPaths: outcome.artifactPaths,
      snapshotDiagnosticSamples: outcome.snapshotDiagnosticSamples,
      armSaveScript: sessionPreparation.armSaveScript,
      coordinator,
      keepSession,
      suppressedTerminalCloseIndex,
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

/**
 * #1478 P5 stage C2b (narrowed further by the #1555 review's neutral-outcomes
 * pass): the daemon's `AdReplayStepRuntime` adapter — the narrow
 * execute/capture/observe/stamp capability bag `runAdReplay`'s step loop
 * threads through. Every member closes over this one request's
 * `ReplayStepContext` (or the outer accumulators it needs to keep in sync);
 * none of it is reachable from the engine except through these functions.
 *
 * `lastResponse` is the side-map the neutral-outcomes design relies on: the
 * ONLY place a real `DaemonResponse` is built or held. `executeStep` and
 * `handleActionFailure` each record the wire response they just built here
 * before projecting it down to the neutral `AdReplayStepOutcome`/
 * `AdReplayStepFailure` the engine actually sees; `readLastResponse` lets
 * `runReplayScriptFile` recover the exact final response once `runAdReplay`
 * reports which step failed, so the client-visible wire output never changes
 * even though the engine itself never touches it.
 */
function createAdReplayStepRuntime(params: {
  ctx: ReplayStepContext;
  req: DaemonRequest;
  /** The outer exception-reporting mirror (see `runReplayScriptFile`'s catch block). */
  artifactPaths: Set<string>;
  onStep: ReplayTestAttemptStepSink | undefined;
  armSaveScript: () => void;
}): { runtime: AdReplayStepRuntime; readLastResponse: () => DaemonResponse | undefined } {
  const { ctx, req, artifactPaths, onStep, armSaveScript } = params;
  let lastResponse: DaemonResponse | undefined;
  const runtime: AdReplayStepRuntime = {
    async executeStep(action, index, stepArtifactPaths) {
      const response = await resolveReplayStepResponse(ctx, action, index, [...stepArtifactPaths]);
      lastResponse = response;
      const entries = collectReplayActionArtifactPaths(response);
      entries.forEach((entry) => artifactPaths.add(entry));
      if (response.ok) return { status: 'ok', artifactPaths: entries };
      return { status: 'failed', failure: toAdReplayStepFailure(response, entries) };
    },
    async handleActionFailure({
      action,
      index,
      artifactPaths: failureArtifactPaths,
      snapshotDiagnosticSamples,
    }) {
      const failedResponse = asFailedReplayStepResponse(lastResponse);
      const finalResponse = await buildReplayActionFailure(
        ctx,
        req,
        action,
        index,
        failedResponse,
        [...failureArtifactPaths],
        [...snapshotDiagnosticSamples],
      );
      lastResponse = finalResponse;
      // `buildReplayActionFailure` is typed `Promise<DaemonResponse>` (it
      // shares its return type with the ordinary success path elsewhere in
      // this module) but always produces a failed response on this call
      // path — it exists to WRAP a failure with diagnostics/repair-hold
      // marking, never to turn one into a success.
      return toAdReplayStepFailure(
        asFailedReplayStepResponse(finalResponse),
        collectReplayActionArtifactPaths(finalResponse),
      );
    },
    armStep: armSaveScript,
    isRepairArmed: () => ctx.coordinator.view()?.repairBoundary !== undefined,
    describeStepValue: (action) => describeReplayStepValue(action),
    onStep,
    diagnosticsMarker: () => readSessionSnapshotSampleCount(ctx.sessionStore, ctx.sessionName),
    diagnosticsSince: (marker) =>
      readSessionSnapshotSamplesSince(ctx.sessionStore, ctx.sessionName, marker),
  };
  return { runtime, readLastResponse: () => lastResponse };
}

/**
 * `runAdReplay` only ever calls `handleActionFailure` right after
 * `executeStep` reported `status: 'failed'`, and `executeStep` always sets
 * `lastResponse` to that same failed response before returning — so this
 * narrowing cannot actually fail in practice. The `COMMAND_FAILED` fallback
 * exists only so `buildReplayActionFailure` (which needs a real failed
 * response to wrap) stays total if that invariant is ever violated.
 */
function asFailedReplayStepResponse(
  response: DaemonResponse | undefined,
): Extract<DaemonResponse, { ok: false }> {
  if (response && !response.ok) return response;
  return errorResponse(
    'COMMAND_FAILED',
    'replay step reported failure with no recorded response',
  ) as Extract<DaemonResponse, { ok: false }>;
}

/** Projects a wire response down to the neutral shape the engine's outcome carries. */
function toAdReplayStepFailure(
  response: Extract<DaemonResponse, { ok: false }>,
  artifactPaths: readonly string[],
): AdReplayStepFailure {
  return { kind: response.error.code, message: response.error.message, artifactPaths };
}

async function buildReplayActionFailure(
  ctx: ReplayStepContext,
  req: DaemonRequest,
  action: SessionAction,
  index: number,
  response: Extract<DaemonResponse, { ok: false }>,
  artifactPaths: string[],
  snapshotDiagnosticSamples: SnapshotTimingSample[],
): Promise<DaemonResponse> {
  const heldResponse = (failure: DaemonResponse): DaemonResponse =>
    ctx.coordinator.markSessionHeldIfArmed(failure);
  if (isCompleteTargetBindingDivergenceResponse(response)) return heldResponse(response);
  return heldResponse(
    await withReplayFailureDiagnostics({
      response,
      action,
      index,
      replayPath: ctx.resolved,
      sourcePath: ctx.actionSourcePaths?.[index] ?? ctx.resolved,
      sourceLine: ctx.actionLines[index] ?? 1,
      artifactPaths,
      snapshotDiagnosticSamples,
      scope: ctx.scope,
      req,
      sessionName: ctx.sessionName,
      sessionStore: ctx.sessionStore,
      resumeStamper: ctx.coordinator.resumeStamper,
      logPath: ctx.logPath,
      planActions: ctx.actions,
      planDigest: ctx.planDigest,
      port: ctx.port,
    }),
  );
}

/**
 * A replay-test progress step's display value: the recorded selector's
 * label/text/id term value when every alternative agrees on ONE value, else
 * `undefined`. Needs `readReplaySelectorDisplayValue`'s private selector AST
 * (`replay-selector-port.ts` deliberately keeps it daemon-only — see that
 * file's own comment), so this stays daemon-side and is handed to the engine
 * loop as the narrow `describeStepValue` capability.
 */
function describeReplayStepValue(action: SessionAction): string | undefined {
  const positionals = action.positionals ?? [];
  const selectorValue = readReplaySelectorDisplayValue(positionals[0]);
  if (selectorValue) return selectorValue;
  if (positionals.length === 0) return undefined;
  return positionals.join(' ');
}

function completeReplayRun(params: {
  startedAt: number;
  sessionName: string;
  sessionStore: SessionStore;
  replayed: number;
  artifactPaths: readonly string[];
  snapshotDiagnosticSamples: readonly SnapshotTimingSample[];
  armSaveScript: () => void;
  coordinator: ReplayCoordinator;
  keepSession: boolean;
  suppressedTerminalCloseIndex: number | undefined;
}): DaemonResponse {
  const {
    startedAt,
    sessionName,
    sessionStore,
    replayed,
    artifactPaths,
    snapshotDiagnosticSamples,
    armSaveScript,
    coordinator,
    keepSession,
    suppressedTerminalCloseIndex,
  } = params;
  armSaveScript();
  coordinator.markCompleteIfArmed();
  const completedSession = sessionStore.get(sessionName);
  const snapshotDiagnosticsSummary = summarizeSnapshotTimingSamples([...snapshotDiagnosticSamples]);
  return {
    ok: true,
    data: {
      replayed,
      healed: 0,
      session: sessionName,
      sessionActive: completedSession !== undefined,
      artifactPaths: [...artifactPaths],
      ...(snapshotDiagnosticsSummary ? { snapshotDiagnostics: snapshotDiagnosticsSummary } : {}),
      message: formatReplaySuccessMessage(replayed, Date.now() - startedAt),
    } satisfies ReplayCommandResult,
  };
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
};

function prepareReplayPlan(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  tracePath: string | undefined;
  resolved: string;
  coordinator: ReplayCoordinator;
  keepSession: boolean;
}): { ok: true; value: PreparedReplayPlan } | { ok: false; response: DaemonResponse } {
  const { req, sessionName, sessionStore, tracePath, resolved, coordinator } = params;
  // #1555 P1: the authoritative rejection for an unrecognized --replay-backend
  // value. Extraction moved `.ad` inspection to `inspectAdReplay`, which never
  // receives flags — restoring the check here (the one caller of
  // `inspectAdReplay` that reaches this point with a non-Maestro request)
  // matches `src/compat/replay-input.ts`'s `parseReplayInput` exactly, byte
  // for byte, before any plan/session work begins. `replayBackend: 'maestro'`
  // still passes here because `runReplayScriptFile` has already routed a real
  // Maestro-format request to `runTypedMaestroReplayFile` above; only a
  // stray/unknown value reaches this branch.
  if (req.flags?.replayBackend && req.flags.replayBackend !== 'maestro') {
    return {
      ok: false,
      response: errorResponse(
        'INVALID_ARGS',
        `Unsupported replay backend "${req.flags.replayBackend}".`,
      ),
    };
  }
  // #1555 P1 (digest/resume behind runAdReplay): `digestFlags` is the raw
  // request-level platform/target override — `inspectAdReplay` applies the
  // SAME precedence (flag, then a script-declared platform, then the
  // `context` header) internally that this call site used to apply itself
  // via `readEffectiveReplayPlanDigestMetadata(replayReq.flags)`.
  const manifest = inspectAdReplay(resolved, {
    platform: req.flags?.platform,
    target: req.flags?.target,
  });
  const { metadata, actions, actionLines, actionSourcePaths, planDigest } = manifest;
  const replayReq = applyReplayMetadata(
    { ...req, flags: buildReplayScriptPlatformFlags(req.flags, actions) },
    metadata,
  );
  const preEntrySession = sessionStore.get(sessionName);
  const entryIndex = manifest.resolveEntryIndex({
    from: req.flags?.replayFrom,
    digest: req.flags?.replayPlanDigest,
    pendingRecordAndHeal: coordinator.view()?.pendingRecordAndHeal,
    sessionActionsLength: preEntrySession?.actions.length ?? 0,
  });
  if (!entryIndex.ok) {
    return { ok: false, response: errorResponse('INVALID_ARGS', entryIndex.message) };
  }

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
    },
  };
}

function applyReplayMetadata(
  req: DaemonRequest,
  metadata: AdReplayManifest['metadata'],
): DaemonRequest {
  if (!metadata.platform && !metadata.target) return req;
  return { ...req, flags: buildReplayMetadataFlags(req.flags, metadata) };
}

function buildPreparedReplayScope(params: {
  req: DaemonRequest;
  replayReq: DaemonRequest;
  sessionName: string;
  resolved: string;
  metadata: AdReplayManifest['metadata'];
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
 * even publish or diverge) before the agent gets that chance. The pure
 * decision (`isRepairArmedTerminalCloseAction`) now lives in
 * `@agent-device/ad-replay`'s step loop; this daemon-only preflight — the
 * arm-time EEXIST check above — is unrelated repair authority that stays
 * here.
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

// ADR 0012 step 4: a target-binding divergence is already a complete, final
// REPLAY_DIVERGENCE built from its own pre-action capture — distinguished from
// an action-failure divergence by its non-`action-failure` kind. Pinned
// daemon-side: it re-inspects the already-projected `DaemonResponse` wire
// shape to decide whether the wire-level diagnostics-augmentation step
// applies, which is daemon/wire authority, not engine divergence-kind
// classification (that already happened engine-side, in
// `classifyReplayTarget`/`target-identity.ts`).
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
