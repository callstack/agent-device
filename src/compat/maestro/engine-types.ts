import type {
  MaestroCommand,
  MaestroPlatform,
  MaestroProgram,
  MaestroSelector,
  MaestroSourceLocation,
} from './program-ir.ts';

export type MaestroControlCommand = Extract<
  MaestroCommand,
  { kind: 'runFlow' | 'repeat' | 'retry' }
>;

export type MaestroRuntimeCommand = Exclude<MaestroCommand, MaestroControlCommand>;

export type MaestroObservationFrame = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MaestroObservationEvidence = {
  kind: 'selector';
  selector: MaestroSelector;
  visible: boolean;
  frame?: MaestroObservationFrame;
  candidateCount: number;
  ref?: string;
};

export type MaestroObservation = {
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

export type MaestroObservationEffect = 'preserve' | 'invalidate';

export type MaestroRuntimeResult = {
  observation?: MaestroObservation;
  outputEnv?: Record<string, string>;
  artifactPaths?: string[];
};

export type MaestroRuntimePort = {
  execute(request: MaestroRuntimeRequest): Promise<MaestroRuntimeResult>;
  observe(request: {
    condition: MaestroObservationCondition;
    timeoutMs: number;
    generation: number;
    env: Readonly<Record<string, string>>;
    cachedObservation?: MaestroObservation;
    signal?: AbortSignal;
  }): Promise<MaestroObservation>;
};

export type MaestroCompatibilityTimingPolicy = {
  assertVisibleTimeoutMs: number;
  assertNotVisibleTimeoutMs: number;
  extendedWaitUntilTimeoutMs: number;
  runFlowConditionTimeoutMs: number;
};

export const DEFAULT_MAESTRO_COMPATIBILITY_TIMING_POLICY = {
  assertVisibleTimeoutMs: 17_000,
  assertNotVisibleTimeoutMs: 3_000,
  extendedWaitUntilTimeoutMs: 10_000,
  runFlowConditionTimeoutMs: 3_000,
} as const satisfies MaestroCompatibilityTimingPolicy;

export type MaestroEngineEvent = {
  command: MaestroCommand;
  source: MaestroSourceLocation;
  generation: number;
  stepIndex: number;
  stepTotal: number;
};

export type MaestroEngineObserver = {
  commandStarted?(event: MaestroEngineEvent): void;
  commandCompleted?(event: MaestroEngineEvent & { durationMs: number }): void;
  commandFailed?(
    event: MaestroEngineEvent & {
      durationMs: number;
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
  /** Explicit alias for callers passing replay built-ins. */
  builtins?: Readonly<Record<string, string>>;
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
};
