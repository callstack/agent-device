import type { RequestProgressEvent } from '../daemon/request-progress.ts';
import type { ReplaySuiteResult } from '../daemon/types.ts';

export type ReplayTestReporterContext = {
  debug?: boolean;
};

export type ReplayTestReporterLoadContext = {
  spec: string;
  modulePath: string;
};

export type ReplayTestReporter = {
  name: string;
  onProgress?(event: RequestProgressEvent, context: ReplayTestReporterContext): void;
  onSuiteEnd?(suite: ReplaySuiteResult, context: ReplayTestReporterContext): Promise<void> | void;
  getExitCode?(suite: ReplaySuiteResult): number | undefined;
};

export type ReplayTestReporterFactory = (
  options: unknown,
  context: ReplayTestReporterLoadContext,
) => ReplayTestReporter | Promise<ReplayTestReporter>;
