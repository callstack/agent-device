import fs from 'node:fs';
import path from 'node:path';
import { type CommandFlags } from '../../core/dispatch.ts';
import { parseReplayInput } from '../../compat/replay-input.ts';
import { asAppError } from '../../kernel/errors.ts';
import type { DaemonInvokeFn, DaemonRequest, DaemonResponse, SessionAction } from '../types.ts';
import { emitRequestProgress, readReplayTestActionProgress } from '../request-progress.ts';
import { SessionStore } from '../session-store.ts';
import { type ReplayScriptMetadata, writeReplayScript } from '../../replay/script.ts';
import { healReplayAction } from './session-replay-heal.ts';
import { formatScriptActionSummary } from '../../replay/script-utils.ts';
import { errorResponse } from './response.ts';
import { invokeReplayAction } from './session-replay-action-runtime.ts';
import {
  buildReplayVarScope,
  collectReplayShellEnv,
  parseReplayCliEnvEntries,
  readReplayCliEnvEntries,
  readReplayShellEnvSource,
} from '../../replay/vars.ts';
import {
  summarizeSnapshotTimingSamples,
  type SnapshotDiagnosticsSummary,
  type SnapshotTimingSample,
} from '../../snapshot-diagnostics.ts';

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
    let healed = 0;
    for (let index = 0; index < actions.length; index += 1) {
      const action = actions[index];
      if (!action || action.command === 'replay') continue;
      emitReplayTestActionProgress(resolved, index, actions.length);

      const sampleStart = readSessionSnapshotSampleCount(sessionStore, sessionName);
      let response = await invokeReplayAction({
        req: replayReq,
        sessionName,
        action,
        scope,
        filePath: resolved,
        line: actionLines[index] ?? 0,
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
        return withReplayFailureDiagnostics(
          response,
          action,
          index,
          resolved,
          [...artifactPaths],
          snapshotDiagnosticSamples,
        );
      }

      const nextAction = await healReplayAction({
        action,
        sessionName,
        logPath,
        sessionStore,
      });
      if (!nextAction) {
        return withReplayFailureDiagnostics(
          response,
          action,
          index,
          resolved,
          [...artifactPaths],
          snapshotDiagnosticSamples,
        );
      }

      actions[index] = nextAction;
      const healedSampleStart = readSessionSnapshotSampleCount(sessionStore, sessionName);
      response = await invokeReplayAction({
        req: replayReq,
        sessionName,
        action: nextAction,
        scope,
        filePath: resolved,
        line: actionLines[index] ?? 0,
        step: index + 1,
        tracePath: actionTracePath,
        invoke,
      });
      snapshotDiagnosticSamples.push(
        ...readSessionSnapshotSamplesSince(sessionStore, sessionName, healedSampleStart),
      );
      if (!response.ok) {
        collectReplayActionArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
        return withReplayFailureDiagnostics(
          response,
          nextAction,
          index,
          resolved,
          [...artifactPaths],
          snapshotDiagnosticSamples,
        );
      }
      collectReplayActionArtifactPaths(response).forEach((entry) => artifactPaths.add(entry));
      healed += 1;
    }

    if (shouldUpdate && healed > 0) {
      writeReplayScript(resolved, actions, sessionStore.get(sessionName));
    }
    const snapshotDiagnosticsSummary = summarizeSnapshotTimingSamples(snapshotDiagnosticSamples);
    return {
      ok: true,
      data: {
        replayed: actions.length,
        healed,
        session: sessionName,
        artifactPaths: [...artifactPaths],
        ...(snapshotDiagnosticsSummary ? { snapshotDiagnostics: snapshotDiagnosticsSummary } : {}),
      },
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
  });
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

function withReplayFailureDiagnostics(
  response: DaemonResponse,
  action: SessionAction,
  index: number,
  replayPath: string,
  artifactPaths: string[],
  snapshotDiagnosticSamples: SnapshotTimingSample[],
): DaemonResponse {
  return withReplayFailureContext(
    response,
    action,
    index,
    replayPath,
    artifactPaths,
    summarizeSnapshotTimingSamples(snapshotDiagnosticSamples),
  );
}

function withReplayFailureContext(
  response: DaemonResponse,
  action: SessionAction,
  index: number,
  replayPath: string,
  artifactPaths: string[] = [],
  snapshotDiagnostics?: SnapshotDiagnosticsSummary,
): DaemonResponse {
  if (response.ok) return response;
  const step = index + 1;
  return {
    ok: false,
    error: {
      code: response.error.code,
      message: `Replay failed at step ${step} (${formatScriptActionSummary(action)}): ${response.error.message}`,
      hint: response.error.hint,
      diagnosticId: response.error.diagnosticId,
      logPath: response.error.logPath,
      details: {
        ...(response.error.details ?? {}),
        replayPath,
        step,
        action: action.command,
        positionals: action.positionals ?? [],
        artifactPaths,
        ...(snapshotDiagnostics ? { snapshotDiagnostics } : {}),
      },
    },
  };
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
