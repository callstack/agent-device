import type { RequestProgressEvent } from '../../request/progress.ts';
import type { ReplaySuiteResult } from '../../daemon/types.ts';
import {
  getReplayTestReporterExitCode,
  resolveReplayTestReporters,
  runReplayTestReporterProgress,
  runReplayTestReporters,
} from './reporters/registry.ts';
import type {
  ReplayTestReporter,
  ReplayTestReporterContext,
  ReplayTestReporterStream,
} from './reporters/types.ts';
import { printJson } from '../../utils/output.ts';

export type ReplayTestReporterRuntime = {
  reporters: ReplayTestReporter[];
  context: ReplayTestReporterContext;
  onProgress(event: RequestProgressEvent): void;
};

type ReporterWritableStream = {
  isTTY?: boolean;
  columns?: number;
  write(text: string): boolean;
};

export async function renderReplayTestResponse(options: {
  suite: ReplaySuiteResult;
  json?: boolean;
  debug?: boolean;
  verbose?: boolean;
  reporter?: string[];
  reportJunit?: string;
  reporterRuntime?: ReplayTestReporterRuntime;
}): Promise<number> {
  const { suite, json, debug, verbose, reporter, reportJunit } = options;
  const runtime =
    options.reporterRuntime ??
    (await createReplayTestReporterRuntime({ debug, verbose, reporter, reportJunit, json }));
  await runReplayTestReporters(runtime.reporters, suite, runtime.context);
  if (json) {
    printJson({ success: true, data: suite });
  }
  return getReplayTestReporterExitCode(runtime.reporters, suite);
}

export async function createReplayTestReporterRuntime(options: {
  debug?: boolean;
  verbose?: boolean;
  reporter?: string[];
  reportJunit?: string;
  json?: boolean;
}): Promise<ReplayTestReporterRuntime> {
  const reporters = await resolveReplayTestReporters({
    reporters: options.reporter,
    reportJunit: options.reportJunit,
    json: options.json,
  });
  const context = createReplayTestReporterContext({
    debug: options.debug,
    verbose: options.verbose,
  });
  return {
    reporters,
    context,
    onProgress(event) {
      runReplayTestReporterProgress(reporters, event, context);
    },
  };
}

function createReplayTestReporterContext(options: {
  debug?: boolean;
  verbose?: boolean;
}): ReplayTestReporterContext {
  return {
    debug: options.debug,
    verbose: options.verbose ?? options.debug,
    stdout: createReplayTestReporterStream(process.stdout),
    stderr: createReplayTestReporterStream(process.stderr),
  };
}

function createReplayTestReporterStream(stream: ReporterWritableStream): ReplayTestReporterStream {
  return {
    isTTY: stream.isTTY === true,
    columns: stream.columns,
    write: (text) => stream.write(text),
  };
}
