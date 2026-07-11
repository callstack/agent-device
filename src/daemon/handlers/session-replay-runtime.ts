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
import { type ReplayScriptMetadata } from '../../replay/script.ts';
import { computeReplayPlanDigest } from '../../replay/plan-digest.ts';
import { errorResponse } from './response.ts';
import { invokeReplayAction } from './session-replay-action-runtime.ts';
import { tryParseSelectorChain } from '../../selectors/index.ts';
import {
  buildReplayVarScope,
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
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
    // set (rejected earlier, in handleSessionReplayCommands).
    const entryIndex = resolveReplayEntryIndex(req.flags, actions.length, planDigest, actions);
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
    for (let index = entryIndex.value; index < actions.length; index += 1) {
      const action = actions[index];
      if (!action || action.command === 'replay') continue;
      emitReplayTestActionProgress(resolved, index, actions.length, action);

      const sampleStart = readSessionSnapshotSampleCount(sessionStore, sessionName);
      // ADR 0012 migration step 4: verify the recorded target BEFORE sending
      // the device action. A non-verified outcome is a complete target-binding
      // REPLAY_DIVERGENCE (built from its own pre-action capture); only a
      // verified outcome dispatches, carrying the verified member's identity
      // as a post-resolution guard so dispatch's own resolution (occlusion/
      // visibility guards verification does not replicate) must land on the
      // SAME element or refuse pre-action.
      const verification = await verifyReplayActionTarget({
        action,
        scope,
        sourcePath: actionSourcePaths?.[index] ?? resolved,
        sourceLine: actionLines[index] ?? 1,
        replayPath: resolved,
        step: index + 1,
        sessionName,
        sessionStore,
        logPath,
        artifactPaths: [...artifactPaths],
        responseLevel: req.meta?.responseLevel,
        planActions: actions,
        planDigest,
      });
      const guard = verification.verified ? verification.guard : undefined;
      const guardedReq = guard
        ? { ...replayReq, internal: { ...replayReq.internal, replayTargetGuard: guard.expected } }
        : replayReq;
      let response = verification.verified
        ? await invokeReplayAction({
            req: guardedReq,
            sessionName,
            action,
            scope,
            filePath: resolved,
            line: actionLines[index] ?? 1,
            sourcePath: actionSourcePaths?.[index],
            step: index + 1,
            tracePath: actionTracePath,
            invoke,
          })
        : verification.response;
      if (guard && isReplayTargetGuardMismatchResponse(response)) {
        response = await buildReplayTargetGuardMismatchResponse({
          action,
          scope,
          guard,
          failedResponse: response,
          sourcePath: actionSourcePaths?.[index] ?? resolved,
          sourceLine: actionLines[index] ?? 1,
          replayPath: resolved,
          step: index + 1,
          sessionName,
          sessionStore,
          logPath,
          artifactPaths: [...artifactPaths],
          responseLevel: req.meta?.responseLevel,
          planActions: actions,
          planDigest,
        });
      }
      snapshotDiagnosticSamples.push(
        ...readSessionSnapshotSamplesSince(sessionStore, sessionName, sampleStart),
      );
      collectReplayActionArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
      if (!response.ok) {
        // A complete target-binding divergence must pass through unchanged —
        // failStep would rebuild it as a generic action-failure divergence
        // (double-capture + lost kind/targetBinding).
        if (isCompleteTargetBindingDivergenceResponse(response)) return response;
        return await failStep(response, action, index);
      }
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
