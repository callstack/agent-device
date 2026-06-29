import type { RequestProgressEvent } from '../daemon/request-progress.ts';
import type { ReplaySuiteResult } from '../daemon/types.ts';

export type ReplayTestReporterContext = {
  debug?: boolean;
  writeStdout(text: string): void;
  mkdir(path: string): void;
  writeFile(path: string, contents: string): void;
};

export type ReplayTestReporterLoadContext = {
  spec: string;
  modulePath: string;
};

export type ReplayTestReporter = {
  name: string;
  /**
   * Reserved for live reporter support. The CLI currently invokes reporters after the final
   * ReplaySuiteResult is available, so custom reporters should use onSuiteEnd for now.
   */
  onProgress?(event: RequestProgressEvent, context: ReplayTestReporterContext): void;
  onSuiteEnd?(suite: ReplaySuiteResult, context: ReplayTestReporterContext): Promise<void> | void;
  getExitCode?(suite: ReplaySuiteResult): number | undefined;
};

export type ReplayTestReporterFactory = (
  context: ReplayTestReporterLoadContext,
) => ReplayTestReporter | Promise<ReplayTestReporter>;
