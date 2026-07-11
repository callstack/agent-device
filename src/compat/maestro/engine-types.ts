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

export type MaestroObservation = {
  generation: number;
  matched: boolean;
  candidateCount?: number;
  evidence?: unknown;
};

export type MaestroObservationCondition =
  | { kind: 'visible'; selector: MaestroSelector }
  | { kind: 'notVisible'; selector: MaestroSelector };

export type MaestroRuntimeRequest = {
  command: MaestroRuntimeCommand;
  appId?: string;
  generation: number;
  cachedObservation?: MaestroObservation;
};

export type MaestroRuntimeResult = {
  mutated: boolean;
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
    cachedObservation?: MaestroObservation;
  }): Promise<MaestroObservation>;
};

export type MaestroEngineEvent = {
  command: MaestroCommand;
  source: MaestroSourceLocation;
  generation: number;
};

export type MaestroEngineObserver = {
  commandStarted?(event: MaestroEngineEvent): void;
  commandCompleted?(event: MaestroEngineEvent & { durationMs: number }): void;
  commandFailed?(event: MaestroEngineEvent & { durationMs: number; error: unknown }): void;
};

export type MaestroEngineOptions = {
  env?: Record<string, string>;
  platform?: MaestroPlatform;
  loadProgram?: (path: string, parentSource?: string) => Promise<MaestroProgram>;
  evaluateExpression?: (expression: string, env: Readonly<Record<string, string>>) => boolean;
  observer?: MaestroEngineObserver;
  now?: () => number;
};

export type MaestroEngineResult = {
  executed: number;
  skipped: number;
  generation: number;
  artifactPaths: string[];
};
