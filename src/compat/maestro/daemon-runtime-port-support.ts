import path from 'node:path';
import type { CommandFlags } from '../../core/dispatch.ts';
import type {
  DaemonInvokeFn,
  DaemonRequest,
  DaemonResponse,
  DaemonResponseData,
} from '../../daemon/types.ts';
import { AppError } from '../../kernel/errors.ts';
import type { MaestroPlatform } from './program-ir.ts';
import type { MaestroObservation } from './engine-types.ts';
import type {
  MaestroRuntimeOperationContext,
  MaestroTargetMatch,
  MaestroTargetQuery,
} from './runtime-port-types.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import type { DaemonMaestroRuntimeDependencies } from './daemon-runtime-port-observation.ts';

type DirectMaestroRuntimeDependencies = DaemonMaestroRuntimeDependencies & {
  readonly resolveGestureViewport: (
    context: MaestroRuntimeOperationContext,
  ) => Promise<Rect | undefined>;
};

export type DaemonMaestroRuntimeBaseRequest = Omit<DaemonRequest, 'command' | 'positionals'>;

export type CreateDaemonMaestroRuntimeOperationsOptions = {
  readonly baseReq: DaemonMaestroRuntimeBaseRequest;
  readonly invoke: DaemonInvokeFn;
  readonly dependencies: DirectMaestroRuntimeDependencies;
  readonly sourcePath?: string;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
};

export async function invokeMaestroPublicCommand(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  command: string,
  positionals: string[],
  requestOptions: {
    input?: Record<string, unknown>;
    flags?: CommandFlags;
    internal?: DaemonRequest['internal'];
  } = {},
): Promise<DaemonResponseData | undefined> {
  const { input, flags, internal: requestInternal } = requestOptions;
  const {
    input: _baseInput,
    flags: baseFlags,
    internal: baseInternal,
    ...baseReq
  } = options.baseReq;
  const effectiveFlags = flags ?? stripReplayControlFlags(baseFlags);
  const effectiveInternal =
    requestInternal === undefined ? baseInternal : { ...baseInternal, ...requestInternal };
  const response = await options.invoke({
    ...baseReq,
    command,
    positionals,
    ...(input === undefined ? {} : { input }),
    ...(effectiveFlags === undefined ? {} : { flags: effectiveFlags }),
    ...(effectiveInternal === undefined ? {} : { internal: effectiveInternal }),
  });
  if (!response.ok) throw daemonResponseError(response);
  return response.data;
}

export function flagsWith(
  base: CommandFlags | undefined,
  extra: Partial<CommandFlags>,
): CommandFlags | undefined {
  const flags = { ...stripReplayControlFlags(base), ...extra };
  return Object.keys(flags).length > 0 ? flags : undefined;
}

function stripReplayControlFlags(flags: CommandFlags | undefined): CommandFlags | undefined {
  if (!flags) return undefined;
  const nested = { ...flags };
  delete nested.saveScript;
  delete nested.replayUpdate;
  delete nested.replayBackend;
  delete nested.replayEnv;
  delete nested.replayShellEnv;
  delete nested.replayFrom;
  delete nested.replayPlanDigest;
  delete nested.failFast;
  delete nested.timeoutMs;
  delete nested.retries;
  delete nested.recordVideo;
  delete nested.shardAll;
  delete nested.shardSplit;
  delete nested.shardCount;
  delete nested.shardIndex;
  delete nested.maestro;
  return Object.keys(nested).length > 0 ? nested : undefined;
}

export function launchArgumentValues(
  value:
    | { kind: 'scalar'; value: string | number | boolean }
    | { kind: 'list'; values: Array<string | number | boolean> }
    | { kind: 'map'; values: Record<string, string | number | boolean> }
    | undefined,
): string[] {
  if (!value) return [];
  if (value.kind === 'scalar') return [String(value.value)];
  if (value.kind === 'list') return value.values.map(String);
  return Object.entries(value.values).flatMap(([key, entry]) => [key, String(entry)]);
}

export function observationFromMatch(
  selector: MaestroTargetQuery['selector'],
  match: MaestroTargetMatch,
): MaestroObservation {
  return {
    generation: match.generation,
    matched: match.matched && match.visible,
    candidateCount: match.candidateCount,
    evidence: {
      kind: 'selector',
      selector,
      visible: match.visible,
      candidateCount: match.candidateCount,
      ...(match.ref ? { ref: match.ref } : {}),
    },
  };
}

export function artifactPathsFromData(data: DaemonResponseData | undefined): string[] {
  if (!data) return [];
  const paths: string[] = [];
  if (typeof data.path === 'string') paths.push(data.path);
  if (Array.isArray(data.artifactPaths)) {
    paths.push(...data.artifactPaths.filter((value): value is string => typeof value === 'string'));
  }
  if (Array.isArray(data.artifacts)) {
    for (const artifact of data.artifacts) {
      if (typeof artifact.localPath === 'string') paths.push(artifact.localPath);
      else if (typeof artifact.path === 'string') paths.push(artifact.path);
    }
  }
  return [...new Set(paths)];
}

export function resolveScriptPath(
  file: string,
  context: MaestroRuntimeOperationContext,
  sourcePath: string | undefined,
): string {
  if (path.isAbsolute(file)) return file;
  const parent = context.source?.path ?? sourcePath;
  if (!parent) {
    throw new AppError('INVALID_ARGS', 'Maestro runScript file paths require a source path.');
  }
  return path.resolve(path.dirname(parent), file);
}

export function stringifyEnvironment(
  env: Record<string, string | number | boolean>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, String(value)]));
}

function daemonResponseError(response: Extract<DaemonResponse, { ok: false }>): AppError {
  const error = response.error;
  const details = {
    ...(error.details ?? {}),
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    ...(error.diagnosticId === undefined ? {} : { diagnosticId: error.diagnosticId }),
    ...(error.logPath === undefined ? {} : { logPath: error.logPath }),
    ...(error.retriable === undefined ? {} : { retriable: error.retriable }),
    ...(error.supportedOn === undefined ? {} : { supportedOn: error.supportedOn }),
  };
  return new AppError(error.code, error.message, Object.keys(details).length ? details : undefined);
}
