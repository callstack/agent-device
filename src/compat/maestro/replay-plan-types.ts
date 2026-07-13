import type { MaestroProgramLoader } from './program-loader.ts';
import type { MaestroPlatform, MaestroSourceLocation } from './program-ir.ts';
import type { MaestroControlCommand, MaestroRuntimeCommand } from './engine-types.ts';
import type { SessionRuntimeHints } from '../../kernel/contracts.ts';

export type MaestroReplayPlanScope = Readonly<Record<string, string | number | boolean>>;

type MaestroReplayPlanStepBase = {
  readonly source: MaestroSourceLocation;
  readonly scopes: readonly MaestroReplayPlanScope[];
  readonly appId?: string;
};

export type MaestroReplayPlanCommandStep = MaestroReplayPlanStepBase & {
  readonly kind: 'command';
  readonly command: MaestroRuntimeCommand;
};

export type MaestroReplayPlanOpaqueStep = MaestroReplayPlanStepBase & {
  readonly kind: 'opaque';
  readonly command: MaestroControlCommand;
  readonly body: readonly MaestroReplayPlanStep[];
};

export type MaestroReplayPlanStep = MaestroReplayPlanCommandStep | MaestroReplayPlanOpaqueStep;

export type MaestroReplayPlan = {
  readonly kind: 'maestroReplayPlan';
  readonly platform?: MaestroPlatform;
  readonly target?: string;
  readonly runtimeHints?: Readonly<SessionRuntimeHints>;
  /** Effective static values used to resolve the plan; runtime output values are excluded. */
  readonly initialStaticEnv: Readonly<Record<string, string | number | boolean>>;
  readonly steps: readonly MaestroReplayPlanStep[];
  readonly total: number;
  readonly digest: string;
  /** Counts retained for the existing executeMaestroProgram result shape. */
  readonly compatibility: {
    readonly staticallyExecutedControls: number;
    readonly staticallySkippedControls: number;
  };
};

export type MaestroReplayPlanOptions = {
  /** Highest-precedence invocation values, normally CLI over shell. */
  readonly env?: Readonly<Record<string, string>>;
  /** Lowest-precedence defaults, normally replay built-ins. */
  readonly defaults?: Readonly<Record<string, string | number | boolean>>;
  /** Alias for defaults for callers that name this layer explicitly. */
  readonly builtins?: Readonly<Record<string, string>>;
  readonly platform?: MaestroPlatform;
  readonly target?: string;
  readonly runtimeHints?: Readonly<SessionRuntimeHints>;
  readonly loadProgram?: MaestroProgramLoader;
  readonly signal?: AbortSignal;
};

export type MaestroReplayResumeRequest = {
  readonly from?: number;
  readonly planDigest?: string;
};

export type MaestroReplayResumePreflight =
  | { readonly allowed: true; readonly startIndex: number }
  | { readonly allowed: false; readonly reason: string };

export type MaestroReplayStartIndex = {
  readonly startIndex: number;
  readonly plan: MaestroReplayPlan;
};
