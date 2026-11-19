import type { RequestProgressEvent } from '@agent-device/contracts/progress';
import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import { escapeTerminalText } from '@agent-device/kernel/redaction';
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
  const exitCode = getReplayTestReporterExitCode(runtime.reporters, suite);
  if (json) {
    const { printJson } = await import('../../commands/output/json.ts');
    printJson({ success: true, data: suite });
  }
  return exitCode;
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
      // A command progress line (an upload, for one) is not a reporter event: the reporter that draws the live row
      // writes it on its own row, and without one it goes to stderr as it does for every other command, escaped.
      if (event.type === 'command') {
        const owner = reporters.find((reporter) => reporter.onCommandProgress);
        if (owner?.onCommandProgress) owner.onCommandProgress(event.message, context);
        else context.stderr.write(escapeTerminalText(`${event.message}\n`));
        return;
      }
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
