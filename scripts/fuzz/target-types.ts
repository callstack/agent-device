// Shape of a parser fuzz target (#1414).
//
// Lives apart from the target lists so the real parser targets (targets.ts) and the
// deliberately-broken self-check targets (self-check-targets.ts) can share it without an
// import cycle through the registry that unifies them.

/** Names of the real parser targets the lane fuzzes. */
export type ParserTargetName =
  | 'cli-args'
  | 'selector'
  | 'replay-script'
  | 'batch-steps'
  | 'maestro';

/** Names of the broken-on-purpose targets that prove the harness can still fail. */
export type SelfCheckTargetName =
  | 'self-check-untyped-throw'
  | 'self-check-empty-hint'
  | 'self-check-hang';

export type FuzzTargetName = ParserTargetName | SelfCheckTargetName;

export type FuzzTarget = {
  name: FuzzTargetName;
  /** Human-readable description used in failure reports. */
  description: string;
  /** Runs the parser on one case; may throw. */
  run: (input: string) => void;
  /** Valid-ish inputs the mutator derives cases from. */
  seeds: string[];
};
