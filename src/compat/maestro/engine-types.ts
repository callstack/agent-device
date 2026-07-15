import type {
  MaestroCommand,
  MaestroPlatform,
  MaestroProgram,
  MaestroSelector,
  MaestroSourceLocation,
} from './program-ir.ts';
import type { MaestroCompatibilityTimingPolicy } from './compatibility-policy.ts';

export type MaestroControlCommand = Extract<
  MaestroCommand,
  { kind: 'runFlow' | 'repeat' | 'retry' }
>;

export type MaestroRuntimeCommand = Exclude<MaestroCommand, MaestroControlCommand>;

export type MaestroControlCommandDescriptor =
  | {
      readonly kind: 'runFlow';
      readonly source: MaestroSourceLocation;
      readonly when?: Extract<MaestroControlCommand, { kind: 'runFlow' }>['when'];
      readonly label?: string;
      readonly includePath?: string;
    }
  | {
      readonly kind: 'repeat';
      readonly source: MaestroSourceLocation;
      readonly times: number | string;
    }
  | {
      readonly kind: 'retry';
      readonly source: MaestroSourceLocation;
      readonly maxRetries?: number | string;
    };

export function isMaestroControlCommandDescriptor(
  command: MaestroRuntimeCommand | MaestroControlCommandDescriptor,
): command is MaestroControlCommandDescriptor {
  switch (command.kind) {
    case 'runFlow':
      return !('include' in command);
    case 'repeat':
    case 'retry':
      return !('commands' in command);
    default:
      return false;
  }
}

declare const maestroObservationIdentity: unique symbol;
export type MaestroObservationIdentity = string & {
  readonly [maestroObservationIdentity]: true;
};

export type MaestroObservationEvidence = {
  kind: 'selector';
  selector: MaestroSelector;
  visible: boolean;
  candidateCount: number;
  ref?: string;
};

export type MaestroObservation = {
  identity?: MaestroObservationIdentity;
  generation: number;
  matched: boolean;
  candidateCount?: number;
  evidence?: MaestroObservationEvidence;
};

export type MaestroObservationCondition =
  | { kind: 'visible'; selector: MaestroSelector }
  | { kind: 'notVisible'; selector: MaestroSelector };

export type MaestroRuntimeRequest = {
  command: MaestroRuntimeCommand;
  env: Readonly<Record<string, string>>;
  appId?: string;
  generation: number;
  cachedObservation?: MaestroObservation;
  invalidateObservation(): void;
  signal?: AbortSignal;
};

export type MaestroObservationRequest = {
  condition: MaestroObservationCondition;
  timeoutMs: number;
  generation: number;
  env: Readonly<Record<string, string>>;
  cachedObservation?: MaestroObservation;
  signal?: AbortSignal;
};

export type MaestroObservationEffect = 'preserve' | 'invalidate';

export type MaestroRuntimeResult = {
  observation?: MaestroObservation;
  outputEnv?: Record<string, string>;
  artifactPaths?: string[];
};

export type MaestroRuntimeMetrics = {
  hierarchyCaptures: number;
  screenshotCaptures: number;
  tapRetries: number;
};

export type MaestroRuntimePort = {
  execute(request: MaestroRuntimeRequest): Promise<MaestroRuntimeResult>;
  observe(request: MaestroObservationRequest): Promise<MaestroObservation>;
  readMetrics?(): MaestroRuntimeMetrics;
};

export type MaestroEngineEvent = {
  command: MaestroRuntimeCommand | MaestroControlCommandDescriptor;
  source: MaestroSourceLocation;
  generation: number;
  stepIndex: number;
  stepTotal: number;
};

export type MaestroEngineObserver = {
  commandStarted?(event: MaestroEngineEvent): void;
  commandCompleted?(
    event: MaestroEngineEvent & { durationMs: number; runtimeMetrics?: MaestroRuntimeMetrics },
  ): void;
  commandFailed?(
    event: MaestroEngineEvent & {
      durationMs: number;
      runtimeMetrics?: MaestroRuntimeMetrics;
      error: unknown;
      artifactPaths: readonly string[];
      expandedVariables: Readonly<Record<string, string>>;
    },
  ): void;
};

export type MaestroEngineOptions = {
  /** Highest-precedence invocation values, normally CLI over shell. */
  env?: Readonly<Record<string, string>>;
  /** Lowest-precedence defaults, normally replay built-ins. */
  defaults?: Readonly<Record<string, string | number | boolean>>;
  platform?: MaestroPlatform;
  target?: string;
  /** Internal zero-based plan offset. Prefer from/planDigest for resume callers. */
  startIndex?: number;
  /** One-based safe resume request and its plan digest. */
  from?: number;
  planDigest?: string;
  loadProgram?: (
    path: string,
    parentSource?: string,
    signal?: AbortSignal,
  ) => Promise<MaestroProgram>;
  timing?: Partial<MaestroCompatibilityTimingPolicy>;
  signal?: AbortSignal;
  observer?: MaestroEngineObserver;
  now?: () => number;
};

export type MaestroEngineResult = {
  executed: number;
  skipped: number;
  generation: number;
  artifactPaths: string[];
  warnings?: string[];
};
