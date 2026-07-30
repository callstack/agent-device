import type { NormalizedError } from '@agent-device/kernel/errors';

export type TargetShutdownResult = {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: NormalizedError;
};
