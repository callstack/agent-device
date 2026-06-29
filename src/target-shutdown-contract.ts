import type { NormalizedError } from './kernel/errors.ts';

export type TargetShutdownResult = {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: NormalizedError;
};
