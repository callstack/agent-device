import type { NormalizedError } from './utils/errors.ts';

export type TargetShutdownResult = {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: NormalizedError;
};
