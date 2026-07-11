import fs from 'node:fs';
import path from 'node:path';
import { type CommandFlags } from '../../core/dispatch.ts';
import { parseReplayInput } from '../../compat/replay-input.ts';
import { asAppError } from '../../kernel/errors.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import {
  emitRequestProgress,
  readReplayTestActionProgress,
  type ReplayTestProgressEvent,
} from '../../request/progress.ts';
import { SessionStore } from '../session-store.ts';
import { type ReplayScriptMetadata, writeReplayScript } from '../../replay/script.ts';
import { healReplayAction } from './session-replay-heal.ts';
import { formatDivergenceActionLabel } from '../../replay/script-utils.ts';
import { buildDisplayPositionals } from '../session-event-action.ts';
import { errorResponse } from './response.ts';
import { invokeReplayAction } from './session-replay-action-runtime.ts';
import { tryParseSelectorChain } from '../../selectors/index.ts';
import {
  buildReplayVarScope,
  collectReplayScrubbableVarValues,
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
  type ReplayVarScope,
} from '../../replay/vars.ts';
import {
  summarizeSnapshotTimingSamples,
  type SnapshotDiagnosticsSummary,
  type SnapshotTimingSample,
} from '../../snapshot-diagnostics.ts';
import { buildReplayFailureDivergence } from './session-replay-divergence.ts';
import { scrubReplayVarValues, type ReplayVarScrubEntry } from '../../replay/divergence.ts';
import type { ReplayCommandResult } from '../../contracts/replay.ts';

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
    if (req.flags?.replayUpdate === true && parsed.updateUnsupportedMessage) {
      return errorResponse('INVALID_ARGS', parsed.updateUnsupportedMessage);
    }
    if (req.flags?.replayUpdate === true && metadata.env && Object.keys(metadata.env).length > 0) {
      return errorResponse(
        'INVALID_ARGS',
        'replay -u does not yet preserve env directives. Temporarily remove the env lines, run replay -u, then restore them.',
      );
    }
    if (req.flags?.replayUpdate === true && actionsContainInterpolation(actions)) {
      return errorResponse(
        'INVALID_ARGS',
        'replay -u does not yet preserve ${VAR} substitutions. Resolve or inline the variables before running with -u.',
      );
    }
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
    const shouldUpdate = req.flags?.replayUpdate === true;
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
      });
    let healed = 0;
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (!action || action.command === 'replay') continue;
      emitReplayTestActionProgress(resolved, index, actions.length, action);

      const sampleStart = readSessionSnapshotSampleCount(sessionStore, sessionName);
      let response = await invokeReplayAction({
        req: replayReq,
        sessionName,
        action,
        scope,
        filePath: resolved,
        line: actionLines[index] ?? 1,
        sourcePath: actionSourcePaths?.[index],
        step: index + 1,
        tracePath: actionTracePath,
        invoke,
      });
      snapshotDiagnosticSamples.push(
        ...readSessionSnapshotSamplesSince(sessionStore, sessionName, sampleStart),
      );
      if (response.ok) {
        collectReplayActionArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
        continue;
      }
      collectReplayActionArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
      if (!shouldUpdate) {
        return await failStep(response, action, index);
      }

      const nextAction = await healReplayAction({
        action,
        sessionName,
        logPath,
        sessionStore,
      });
      if (!nextAction) {
        return await failStep(response, action, index);
      }

      actions[index] = nextAction;
      const healedSampleStart = readSessionSnapshotSampleCount(sessionStore, sessionName);
      response = await invokeReplayAction({
        req: replayReq,
        sessionName,
        action: nextAction,
        scope,
        filePath: resolved,
        line: actionLines[index] ?? 1,
        sourcePath: actionSourcePaths?.[index],
        step: index + 1,
        tracePath: actionTracePath,
        invoke,
      });
      snapshotDiagnosticSamples.push(
        ...readSessionSnapshotSamplesSince(sessionStore, sessionName, healedSampleStart),
      );
      if (!response.ok) {
        collectReplayActionArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
        return await failStep(response, nextAction, index);
      }
      collectReplayActionArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
      healed += 1;
    }

    if (shouldUpdate && healed > 0) {
      writeReplayScript(resolved, actions, sessionStore.get(sessionName));
    }
    const snapshotDiagnosticsSummary = summarizeSnapshotTimingSamples(snapshotDiagnosticSamples);
    const wallClockMs = Date.now() - startedAt;
    return {
      ok: true,
      data: {
        replayed: actions.length,
        healed,
        session: sessionName,
        artifactPaths: [...artifactPaths],
        ...(snapshotDiagnosticsSummary ? { snapshotDiagnostics: snapshotDiagnosticsSummary } : {}),
        // ADR 0012: one-line text success summary; --json shape is additive.
        message: formatReplaySuccessMessage(actions.length, wallClockMs),
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

async function withReplayFailureDiagnostics(params: {
  response: DaemonResponse;
  action: SessionAction;
  index: number;
  replayPath: string;
  sourcePath: string;
  sourceLine: number;
  artifactPaths: string[];
  snapshotDiagnosticSamples: SnapshotTimingSample[];
  scope: ReplayVarScope;
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
}): Promise<DaemonResponse> {
  return await withReplayFailureContext({
    ...params,
    snapshotDiagnostics: summarizeSnapshotTimingSamples(params.snapshotDiagnosticSamples),
  });
}

/**
 * Single choke point for replay step failures (ADR 0012 migration step 2):
 * returns `REPLAY_DIVERGENCE` with a bounded `details.divergence` report;
 * the original code/message/hint move into `divergence.cause` verbatim, and
 * the pre-existing flat detail fields are kept for their consumers.
 */
async function withReplayFailureContext(params: {
  response: DaemonResponse;
  action: SessionAction;
  index: number;
  replayPath: string;
  sourcePath: string;
  sourceLine: number;
  artifactPaths?: string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  scope: ReplayVarScope;
  req: DaemonRequest;
  sessionName: string;
  sessionStore: SessionStore;
  logPath: string;
}): Promise<DaemonResponse> {
  const {
    response,
    action,
    index,
    replayPath,
    sourcePath,
    sourceLine,
    artifactPaths = [],
    snapshotDiagnostics,
    scope,
    req,
    sessionName,
    sessionStore,
    logPath,
  } = params;
  if (response.ok) return response;
  // The failing action's own source (attached by withReplayFailureSource,
  // deepest failure wins) beats the top-level wrapper's source.
  const failureSource = readReplayFailureSource(response.error.details?.replaySource);
  // Computed at failure time so runtime outputEnv merges are included.
  const scrubVars = collectReplayScrubbableVarValues(scope);
  const cause = hoistCauseDiagnosticMeta(response.error);
  const divergence = await buildReplayFailureDivergence({
    error: cause,
    action,
    index,
    sourcePath: failureSource?.path ?? sourcePath,
    sourceLine: failureSource?.line ?? sourceLine,
    session: sessionStore.get(sessionName),
    sessionName,
    sessionStore,
    logPath,
    responseLevel: req.meta?.responseLevel,
    scrubVars,
  });
  return buildReplayDivergenceFailureResponse({
    error: cause,
    action,
    step: index + 1,
    replayPath,
    artifactPaths,
    snapshotDiagnostics,
    divergence,
    scrubVars,
  });
}

type ReplayFailureCause = Extract<DaemonResponse, { ok: false }>['error'];

// Throw sites may carry hint/diagnosticId/logPath inside details (the
// documented AppErrorDetails meta keys, normally lifted by normalizeError);
// the categorical cause-detail strip below would lose them, so hoist onto the
// error fields first.
function hoistCauseDiagnosticMeta(error: ReplayFailureCause): ReplayFailureCause {
  return {
    ...error,
    hint: error.hint ?? readStringDetail(error.details, 'hint'),
    diagnosticId: error.diagnosticId ?? readStringDetail(error.details, 'diagnosticId'),
    logPath: error.logPath ?? readStringDetail(error.details, 'logPath'),
  };
}

function readStringDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ADR 0012: arbitrary nested cause details are never serialized into the
// public divergence error — value-bearing command details (fill
// verification's `expected`/`actual`, selector diagnostics, process output)
// are categorically dropped; only machine-dispatchable signals survive.
const SAFE_CAUSE_DETAIL_KEYS = ['reason', 'retriable', 'supportedOn'] as const;

function pickSafeCauseDetails(
  details: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!details) return {};
  const safe: Record<string, unknown> = {};
  for (const key of SAFE_CAUSE_DETAIL_KEYS) {
    if (details[key] !== undefined) safe[key] = details[key];
  }
  return safe;
}

/** Pure wire shaping for the REPLAY_DIVERGENCE failure response. */
function buildReplayDivergenceFailureResponse(params: {
  error: Extract<DaemonResponse, { ok: false }>['error'];
  action: SessionAction;
  step: number;
  replayPath: string;
  artifactPaths: string[];
  snapshotDiagnostics?: SnapshotDiagnosticsSummary;
  divergence: unknown;
  scrubVars: ReplayVarScrubEntry[];
}): DaemonResponse {
  const {
    error,
    action,
    step,
    replayPath,
    artifactPaths,
    snapshotDiagnostics,
    divergence,
    scrubVars,
  } = params;
  return {
    ok: false,
    error: {
      code: 'REPLAY_DIVERGENCE',
      // The cause message can echo an expanded selector; the top-level
      // message gets the same categorical variable scrub as the report.
      message: scrubReplayVarValues(
        `Replay failed at step ${step} (${formatDivergenceActionLabel(action)}): ${error.message}`,
        scrubVars,
      ),
      hint: error.hint === undefined ? undefined : scrubReplayVarValues(error.hint, scrubVars),
      diagnosticId: error.diagnosticId,
      logPath: error.logPath,
      ...(error.retriable !== undefined ? { retriable: error.retriable } : {}),
      ...(error.supportedOn !== undefined ? { supportedOn: error.supportedOn } : {}),
      details: {
        ...pickSafeCauseDetails(error.details),
        replayPath,
        step,
        action: action.command,
        // Categorical text hiding (`<text:N chars>`), never raw fill/type/
        // payload text — the same event-log sanitizer.
        positionals: buildDisplayPositionals(action) ?? [],
        artifactPaths,
        ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
        divergence,
      },
    },
  };
}

function readReplayFailureSource(value: unknown): { path?: string; line?: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const path = typeof record.path === 'string' && record.path.length > 0 ? record.path : undefined;
  const line = typeof record.line === 'number' ? record.line : undefined;
  if (path === undefined && line === undefined) return undefined;
  return { path, line };
}

function formatReplaySuccessMessage(replayed: number, wallClockMs: number): string {
  const seconds = (wallClockMs / 1000).toFixed(1);
  const noun = replayed === 1 ? 'step' : 'steps';
  return `Replayed ${replayed} ${noun} in ${seconds}s`;
}

// fallow-ignore-next-line complexity
export function collectReplayActionArtifactPaths(response: DaemonResponse): string[] {
  if (!response.ok) {
    const paths = response.error.details?.artifactPaths;
    return Array.isArray(paths)
      ? [
          ...new Set(
            paths.filter(
              (candidate): candidate is string =>
                typeof candidate === 'string' && isReplayArtifactPath(candidate),
            ),
          ),
        ]
      : [];
  }
  if (!response.data) return [];
  const candidates: string[] = [];
  if (typeof response.data.path === 'string') candidates.push(response.data.path);
  if (typeof response.data.outPath === 'string') candidates.push(response.data.outPath);
  if (Array.isArray(response.data.artifacts)) {
    for (const artifact of response.data.artifacts) {
      if (!artifact || typeof artifact !== 'object') continue;
      const artifactRecord = artifact as Record<string, unknown>;
      const localPath =
        typeof artifactRecord.localPath === 'string' ? artifactRecord.localPath : undefined;
      const artifactPath =
        typeof artifactRecord.path === 'string' ? artifactRecord.path : undefined;
      if (localPath) candidates.push(localPath);
      else if (artifactPath) candidates.push(artifactPath);
    }
  }
  return [...new Set(candidates.filter((candidate) => isReplayArtifactPath(candidate)))];
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

function isReplayArtifactPath(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

// fallow-ignore-next-line complexity
function actionsContainInterpolation(actions: SessionAction[]): boolean {
  for (const action of actions) {
    for (const positional of action.positionals ?? []) {
      if (typeof positional === 'string' && positional.includes('${')) return true;
    }
    if (containsInterpolation(action.flags)) return true;
    if (containsInterpolation(action.runtime)) return true;
  }
  return false;
}

function containsInterpolation(value: unknown): boolean {
  if (typeof value === 'string') return value.includes('${');
  if (Array.isArray(value)) return value.some(containsInterpolation);
  if (value && typeof value === 'object') return Object.values(value).some(containsInterpolation);
  return false;
}
