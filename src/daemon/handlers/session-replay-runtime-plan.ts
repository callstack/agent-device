import type { SessionAction } from '@agent-device/contracts/session';
import type { CommandFlags } from '@agent-device/contracts/command';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionState } from '../types.ts';
import type { SessionStore } from '../session-store.ts';
import type { ReplayCoordinator } from '../session-replay-coordinator.ts';
import { errorResponse } from './response.ts';
import { buildReplayScriptPlatformFlags } from '../replay-device-selection.ts';
import {
  inspectAdReplay,
  type AdReplayManifest,
  type AdReplayVarSources,
} from '@agent-device/ad-replay';
import {
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
  type ReplayScriptMetadata,
} from '@agent-device/ad-script';
import { resolveReplayFormat } from '../../replay/format.ts';
import { buildReplayBuiltinVars } from './session-replay-vars.ts';
import { runTypedMaestroReplay } from './session-replay-maestro-runtime.ts';
import type { ReplayTestAttemptStepSink } from '@agent-device/replay-test';

/**
 * #1555 P5 (decomposition): `runReplayScriptSource`'s (`session-replay-runtime.ts`) plan-side
 * helpers — everything that inspects the script, resolves its `--from`/`--plan-digest` entry
 * point, and routes a Maestro-format request, before any session-mutating work begins. Extracted
 * verbatim; `buildReplayMetadataFlags` (below) was already here from the #1555 review pass — see
 * its own comment for why it, alone among the digest/resume math, stayed daemon-side.
 */

/**
 * `runReplayScriptSource`'s own parameter shape, named here (rather than derived at the call site
 * via `Parameters<typeof runReplayScriptSource>`) so `routeMaestroReplay` below can reference it
 * without importing back from `session-replay-runtime.ts` — that direction would be a cycle now
 * that the Maestro routing decision lives in this module instead of alongside the function it
 * routes for. `session-replay-runtime.ts` imports this type instead of restating the params.
 */
export type ReplayScriptSourceRunParams = {
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
};

/**
 * Routes a Maestro-format request to the typed Maestro engine, rejecting
 * `--keep-session` (native-`.ad`-only lifecycle) and an active `.ad`
 * `--save-script` repair boundary first. Returns `undefined` for a non-Maestro
 * request so `runReplayScriptSource` continues down the native `.ad` path —
 * extracted from `runReplayScriptSource` itself (fallow complexity) rather than
 * split further, since every branch here is this one routing decision.
 */
export async function routeMaestroReplay(params: {
  resolved: string;
  req: DaemonRequest;
  keepSession: boolean;
  coordinator: ReplayCoordinator;
  maestroParams: ReplayScriptSourceRunParams;
}): Promise<DaemonResponse | undefined> {
  const { resolved, req, keepSession, coordinator, maestroParams } = params;
  if (resolveReplayFormat(resolved, req.flags?.replayBackend) !== 'maestro') return undefined;
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
  return await runTypedMaestroReplay(maestroParams);
}

export type PreparedReplayPlan = {
  replayReq: DaemonRequest;
  actions: SessionAction[];
  actionLines: number[];
  actionSourcePaths: (string | undefined)[] | undefined;
  planDigest: string;
  preEntrySession: SessionState | undefined;
  entryIndex: number;
  /**
   * `${VAR}` scope INPUTS — plain data, never a built `ReplayVarScope`
   * (#1555 review P1, "move variable semantics/planning behind the replay
   * entrypoint"): `runAdReplay` builds the scope and performs every
   * interpolation itself now.
   */
  varSources: AdReplayVarSources;
  actionTracePath: string | undefined;
};

export function prepareReplayPlan(params: {
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  tracePath: string | undefined;
  resolved: string;
  /** The entry script's text, taken from the request's replay script source bundle (#1802). */
  script: string;
  coordinator: ReplayCoordinator;
}): { ok: true; value: PreparedReplayPlan } | { ok: false; response: DaemonResponse } {
  const { req, sessionName, sessionStore, tracePath, resolved, script, coordinator } = params;
  const backendRejection = validateReplayBackendFlag(req);
  if (backendRejection) return { ok: false, response: backendRejection };

  const { manifest, replayReq } = inspectReplayPlanManifest(req, script);
  const { metadata, actions, actionLines, actionSourcePaths, planDigest } = manifest;
  const preEntrySession = sessionStore.get(sessionName);
  const entryIndexResult = resolveReplayPlanEntryIndex({
    req,
    coordinator,
    manifest,
    preEntrySession,
  });
  if (!entryIndexResult.ok) return { ok: false, response: entryIndexResult.response };

  return {
    ok: true,
    value: {
      replayReq,
      actions,
      actionLines,
      actionSourcePaths,
      planDigest,
      preEntrySession,
      entryIndex: entryIndexResult.value,
      varSources: buildPreparedReplayVarSources({
        req,
        replayReq,
        sessionName,
        resolved,
        metadata,
      }),
      actionTracePath: tracePath ?? preEntrySession?.trace?.outPath,
    },
  };
}

/**
 * #1555 P1: the authoritative rejection for an unrecognized --replay-backend
 * value. Extraction moved `.ad` inspection to `inspectAdReplay`, which never
 * receives flags — restoring the check here (the one caller of
 * `inspectAdReplay` that reaches this point with a non-Maestro request)
 * matches `src/compat/replay-input.ts`'s `parseReplayInput` exactly, byte for
 * byte, before any plan/session work begins. `replayBackend: 'maestro'` still
 * passes here because `runReplayScriptSource` has already routed a real
 * Maestro-format request to `runTypedMaestroReplay` above; only a
 * stray/unknown value reaches this branch.
 */
function validateReplayBackendFlag(req: DaemonRequest): DaemonResponse | undefined {
  if (req.flags?.replayBackend && req.flags.replayBackend !== 'maestro') {
    return errorResponse(
      'INVALID_ARGS',
      `Unsupported replay backend "${req.flags.replayBackend}".`,
    );
  }
  return undefined;
}

/**
 * #1555 P1 (digest/resume behind runAdReplay): `digestFlags` is the raw
 * request-level platform/target override — `inspectAdReplay` applies the
 * SAME precedence (flag, then a script-declared platform, then the `context`
 * header) internally that this call site used to apply itself via
 * `readEffectiveReplayPlanDigestMetadata(replayReq.flags)`.
 */
function inspectReplayPlanManifest(
  req: DaemonRequest,
  script: string,
): { manifest: AdReplayManifest; replayReq: DaemonRequest } {
  const manifest = inspectAdReplay(script, {
    platform: req.flags?.platform,
    target: req.flags?.target,
  });
  const replayReq = applyReplayMetadata(
    { ...req, flags: buildReplayScriptPlatformFlags(req.flags, manifest.actions) },
    manifest.metadata,
  );
  return { manifest, replayReq };
}

function resolveReplayPlanEntryIndex(params: {
  req: DaemonRequest;
  coordinator: ReplayCoordinator;
  manifest: AdReplayManifest;
  preEntrySession: SessionState | undefined;
}): { ok: true; value: number } | { ok: false; response: DaemonResponse } {
  const { req, coordinator, manifest, preEntrySession } = params;
  const entryIndex = manifest.resolveEntryIndex({
    from: req.flags?.replayFrom,
    digest: req.flags?.replayPlanDigest,
    pendingRecordAndHeal: coordinator.view()?.pendingRecordAndHeal,
    sessionActionsLength: preEntrySession?.actions.length ?? 0,
  });
  if (!entryIndex.ok) {
    return { ok: false, response: errorResponse('INVALID_ARGS', entryIndex.message) };
  }
  return { ok: true, value: entryIndex.value };
}

function applyReplayMetadata(
  req: DaemonRequest,
  metadata: AdReplayManifest['metadata'],
): DaemonRequest {
  if (!metadata.platform && !metadata.target) return req;
  return { ...req, flags: buildReplayMetadataFlags(req.flags, metadata) };
}

/**
 * The `${VAR}` scope's raw INPUTS — builtins (this request's session/
 * platform/target/device/artifacts-dir), the script's own `env` header, the
 * shell's `AD_VAR_*` entries, and `-e KEY=VALUE` CLI entries — read here,
 * once, from the request/process. `runAdReplay` is the one place these are
 * merged into an actual scope and used to resolve an action (#1555 review
 * P1); this function stops at collecting the plain data.
 */
function buildPreparedReplayVarSources(params: {
  req: DaemonRequest;
  replayReq: DaemonRequest;
  sessionName: string;
  resolved: string;
  metadata: AdReplayManifest['metadata'];
}): AdReplayVarSources {
  const { req, replayReq, sessionName, resolved, metadata } = params;
  return {
    builtins: buildReplayBuiltinVars({
      req: replayReq,
      sessionName,
      metadata,
      resolvedPath: resolved,
    }),
    fileEnv: metadata.env,
    shellEnv: collectReplayShellEnv(readReplayShellEnvSource(req.flags?.replayShellEnv)),
    cliEnv: parseReplayCliEnvEntries(readReplayCliEnvEntries(req.flags?.replayEnv)),
  };
}

/**
 * #1555 review P1 ("digest/resume must also occur behind runAdReplay"): the
 * `--from`/`--plan-digest` resume-point math (`resolveReplayEntryIndex`) and
 * the digest-metadata reader that fed it (`readEffectiveReplayPlanDigestMetadata`,
 * `PendingRecordAndHeal`) moved into `@agent-device/ad-replay` —
 * `inspectAdReplay`'s manifest now exposes the digest as `planDigest` and the
 * resume math as a `resolveEntryIndex` closure, both computed from the SAME
 * effective platform/target precedence this file used to apply itself. Only
 * `buildReplayMetadataFlags` stays here: it builds the REQUEST's flags (used
 * throughout `runReplayScriptSource`, not just for the digest), which is a
 * daemon/wire concern the manifest has no reason to own.
 *
 * Module-private as of the #1555 P5 decomposition: its one caller,
 * `applyReplayMetadata`, now lives in this same file (it used to live in
 * `session-replay-runtime.ts`).
 */
function buildReplayMetadataFlags(
  flags: CommandFlags | undefined,
  metadata: ReplayScriptMetadata,
): CommandFlags {
  return {
    ...(flags ?? {}),
    ...(metadata.platform !== undefined && flags?.platform === undefined
      ? { platform: metadata.platform }
      : {}),
    ...(metadata.target !== undefined && flags?.target === undefined
      ? { target: metadata.target }
      : {}),
  };
}
