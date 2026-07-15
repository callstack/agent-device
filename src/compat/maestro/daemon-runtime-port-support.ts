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
  MaestroRuntimeReadContext,
  MaestroTargetMatch,
  MaestroTargetQuery,
} from './runtime-port-types.ts';
import type { Rect } from '../../kernel/snapshot.ts';
import type { DaemonMaestroRuntimeDependencies } from './daemon-runtime-port-observation.ts';
import { stripUndefined } from '../../utils/parsing.ts';
import {
  projectMaestroPublicOperation,
  type MaestroPublicOperation,
} from './daemon-runtime-public-operation.ts';

type DirectMaestroRuntimeDependencies = DaemonMaestroRuntimeDependencies & {
  readonly resolveGestureViewport: (
    context: MaestroRuntimeReadContext,
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

export async function invokeMaestroPublicOperation(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  operation: MaestroPublicOperation,
): Promise<DaemonResponseData | undefined> {
  const projected = projectMaestroPublicOperation(operation);
  const {
    input: _baseInput,
    flags: baseFlags,
    internal: baseInternal,
    ...baseReq
  } = options.baseReq;
  const effectiveFlags = flagsWith(baseFlags, projected.flags ?? {});
  const effectiveInternal =
    projected.internal === undefined ? baseInternal : { ...baseInternal, ...projected.internal };
  const response = await options.invoke(
    stripUndefined({
      ...baseReq,
      command: projected.command,
      positionals: projected.positionals,
      input: projected.input,
      flags: effectiveFlags,
      internal: effectiveInternal,
    }),
  );
  if (!response.ok) throw daemonResponseError(response);
  return response.data;
}

function flagsWith(
  base: CommandFlags | undefined,
  extra: Partial<CommandFlags>,
): CommandFlags | undefined {
  const maestro =
    base?.maestro === undefined && extra.maestro === undefined
      ? undefined
      : { ...base?.maestro, ...extra.maestro };
  const flags = stripUndefined({
    ...base,
    ...extra,
    maestro,
  });
  return Object.keys(flags).length > 0 ? flags : undefined;
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
  const details = stripUndefined({
    ...(error.details ?? {}),
    hint: error.hint ?? stringErrorDetail(error.details, 'hint'),
    diagnosticId: error.diagnosticId ?? stringErrorDetail(error.details, 'diagnosticId'),
    logPath: error.logPath ?? stringErrorDetail(error.details, 'logPath'),
    retriable: error.retriable ?? booleanErrorDetail(error.details, 'retriable'),
    supportedOn: error.supportedOn ?? stringErrorDetail(error.details, 'supportedOn'),
  });
  return new AppError(error.code, error.message, Object.keys(details).length ? details : undefined);
}

function stringErrorDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = details?.[key];
  return typeof value === 'string' ? value : undefined;
}

function booleanErrorDetail(
  details: Record<string, unknown> | undefined,
  key: string,
): boolean | undefined {
  const value = details?.[key];
  return typeof value === 'boolean' ? value : undefined;
}
