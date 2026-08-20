export type RunnerErrorReason = 'process-failure' | 'empty-output' | 'error-envelope';

export type RunnerOutcome =
  | { kind: 'success'; raw: string; commands: string[] }
  | { kind: 'runner-error'; raw: string; message: string; reason: RunnerErrorReason };

export declare function classifyRunnerOutput(raw: string): RunnerOutcome;
export declare function extractCommands(raw: string): string[];
export declare function runnerErrorOutcome(
  raw: string,
  message: string,
  reason: RunnerErrorReason,
): Extract<RunnerOutcome, { kind: 'runner-error' }>;
