import path from 'node:path';
import type { GestureSemanticInput } from '../../contracts/gesture-plan-types.ts';
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
import type { DaemonMaestroRuntimeDependencies } from './daemon-runtime-port-observation.ts';

export type DaemonMaestroRuntimeBaseRequest = Omit<DaemonRequest, 'command' | 'positionals'>;

export type CreateDaemonMaestroRuntimeOperationsOptions = {
  readonly baseReq: DaemonMaestroRuntimeBaseRequest;
  readonly invoke: DaemonInvokeFn;
  readonly dependencies: DaemonMaestroRuntimeDependencies;
  readonly sourcePath?: string;
  readonly platform: Extract<MaestroPlatform, 'ios' | 'android'>;
};

export async function invokeMaestroPublicCommand(
  options: CreateDaemonMaestroRuntimeOperationsOptions,
  command: string,
  positionals: string[],
  requestOptions: { input?: Record<string, unknown>; flags?: CommandFlags } = {},
): Promise<DaemonResponseData | undefined> {
  const { input, flags } = requestOptions;
  const { input: _baseInput, ...baseReq } = options.baseReq;
  const response = await options.invoke({
    ...baseReq,
    command,
    positionals,
    ...(input === undefined ? {} : { input }),
    ...(flags === undefined ? {} : { flags }),
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

export function publicGestureRequest(
  input: GestureSemanticInput,
  context: MaestroRuntimeOperationContext,
): { command: 'gesture' | 'swipe'; input: Record<string, unknown> } {
  const endpoints = endpointGesture(input);
  if (
    endpoints &&
    (context.authoredSwipe?.kind === 'coordinates' || context.authoredSwipe?.kind === 'target')
  ) {
    return { command: 'swipe', input: endpoints };
  }
  if (endpoints && input.intent === 'fling') return { command: 'swipe', input: endpoints };
  switch (input.intent) {
    case 'fling':
      if ('preset' in input)
        return { command: 'gesture', input: { kind: 'swipe', preset: input.preset } };
      if ('from' in input) return { command: 'swipe', input: { from: input.from, to: input.to } };
      return {
        command: 'gesture',
        input: {
          kind: 'fling',
          direction: input.direction,
          origin: input.origin,
          ...(input.distance === undefined ? {} : { distance: input.distance }),
        },
      };
    case 'pan':
      if ('preset' in input) {
        return {
          command: 'gesture',
          input: { kind: 'swipe', preset: input.preset, durationMs: input.durationMs },
        };
      }
      return {
        command: 'gesture',
        input: {
          kind: 'pan',
          origin: input.origin,
          delta: input.delta,
          ...(input.pointerCount === undefined ? {} : { pointerCount: input.pointerCount }),
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        },
      };
    case 'pinch':
      return {
        command: 'gesture',
        input: {
          kind: 'pinch',
          scale: input.scale,
          ...(input.origin ? { origin: input.origin } : {}),
        },
      };
    case 'rotate':
      return {
        command: 'gesture',
        input: {
          kind: 'rotate',
          degrees: input.degrees,
          ...(input.origin ? { origin: input.origin } : {}),
        },
      };
    case 'transform':
      return {
        command: 'gesture',
        input: {
          kind: 'transform',
          origin: input.origin,
          delta: input.delta,
          scale: input.scale,
          degrees: input.degrees,
          ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
        },
      };
  }
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
      ...(match.rect ? { frame: match.rect } : {}),
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

function endpointGesture(input: GestureSemanticInput): Record<string, unknown> | undefined {
  if (input.intent === 'fling' && 'from' in input) return { from: input.from, to: input.to };
  if (input.intent === 'pan' && !('preset' in input)) {
    return {
      from: input.origin,
      to: { x: input.origin.x + input.delta.x, y: input.origin.y + input.delta.y },
      ...(input.durationMs === undefined ? {} : { durationMs: input.durationMs }),
    };
  }
  return undefined;
}
