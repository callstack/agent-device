// Shape of a parser fuzz target (#1414).
//
// Lives apart from the target lists so the real parser targets (targets.ts) and the
// deliberately-broken self-check targets (self-check-targets.ts) can share it without an
// import cycle through the registry that unifies them.

/** Names of the real parser targets the lane fuzzes. */
export type ParserTargetName =
  | 'cli-args'
  | 'cli-validation'
  | 'selector'
  | 'replay-script'
  | 'batch-steps'
  | 'maestro'
  | 'maestro-validation';

/** Names of the broken-on-purpose targets that prove the harness can still fail. */
export type SelfCheckTargetName =
  | 'self-check-untyped-throw'
  | 'self-check-empty-hint'
  | 'self-check-hang'
  | 'self-check-silent-accept'
  | 'self-check-wrong-code';

export type FuzzTargetName = ParserTargetName | SelfCheckTargetName;

/**
 * `silent-accept` and `wrong-code` only arise from validation targets, whose cases carry an
 * expected outcome (validation-case.ts); the classic targets can only produce the first three.
 */
export type FuzzFailureKind =
  | 'untyped-throw'
  | 'empty-hint'
  | 'hang'
  | 'silent-accept'
  | 'wrong-code';

export type FuzzFailure = {
  target: FuzzTargetName;
  input: string;
  kind: FuzzFailureKind;
  detail: string;
};

export type FuzzTarget = {
  name: FuzzTargetName;
  /** Human-readable description used in failure reports. */
  description: string;
  /** Runs the parser on one case; may throw. */
  run: (input: string) => void;
  /**
   * Full case judgment for expectation-carrying targets; overrides the default
   * rejection-only invariant when present. Still runs under the worker watchdog.
   */
  check?: (input: string) => FuzzFailure | null;
  /** Valid-ish inputs the mutator derives cases from. */
  seeds: string[];
};
