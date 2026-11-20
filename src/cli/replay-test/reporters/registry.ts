import type { ReplaySuiteResult } from '@agent-device/contracts/replay';
import type { RequestProgressEvent } from '@agent-device/contracts/progress';
import { AppError } from '@agent-device/kernel/errors';
import { createCustomReplayTestReporter } from './custom.ts';
import { createDefaultReplayTestReporter, readCommandProgressWriter } from './default.ts';
import { getReplayTestExitCode } from './format.ts';
import { createJunitReplayTestReporter } from './junit.ts';
import { toReplayTestReporterProgressEvent } from './progress.ts';
import { buildReplayTestReporterSpecs, type ReplayTestReporterSpec } from './spec.ts';
import type {
  ReplayTestReporter,
  ReplayTestReporterContext,
  ReplayTestReporterProgressEvent,
} from './types.ts';
import { escapeTerminalText } from '@agent-device/kernel/redaction';

type ReplayTestReporterLiveHook = 'onSuiteStart' | 'onTestStart' | 'onTestStep' | 'onTestResult';

const LIVE_HOOK_BY_EVENT = {
  'suite-start': 'onSuiteStart',
  'test-start': 'onTestStart',
  'test-step': 'onTestStep',
  'test-result': 'onTestResult',
} as const satisfies Record<ReplayTestReporterProgressEvent['type'], ReplayTestReporterLiveHook>;

export async function resolveReplayTestReporters(options: {
  reporters?: string[];
  reportJunit?: string;
  json?: boolean;
}): Promise<ReplayTestReporter[]> {
  const specs = buildReplayTestReporterSpecs(options);
  return await Promise.all(specs.map(resolveReplayTestReporter));
}

export async function runReplayTestReporters(
  reporters: ReplayTestReporter[],
  suite: ReplaySuiteResult,
  context: ReplayTestReporterContext,
): Promise<void> {
  for (const reporter of reporters) {
    await reporter.onSuiteEnd?.(suite, context);
  }
}

export function runReplayTestReporterProgress(
  reporters: ReplayTestReporter[],
  event: RequestProgressEvent,
  context: ReplayTestReporterContext,
): void {
  const reporterEvent = toReplayTestReporterProgressEvent(event);
  if (!reporterEvent) return;
  const hookName = LIVE_HOOK_BY_EVENT[reporterEvent.type];
  for (const reporter of reporters) {
    try {
      const result = invokeReplayTestReporterLiveHook(reporter, reporterEvent, context);
      if (result instanceof Promise) {
        // Live hooks are synchronous by contract and not awaited; a custom reporter
        // that returns a promise anyway has its rejection surfaced here so it cannot
        // crash the CLI with an unhandled rejection.
        void result.catch((error: unknown) =>
          reportReplayTestReporterHookError(reporter, hookName, context, error),
        );
      }
    } catch (error) {
      reportReplayTestReporterHookError(reporter, hookName, context, error);
    }
  }
}

/**
 * A command progress line during the run, such as an upload. The built-in default reporter writes it on its own row;
 * without one it goes to stderr escaped, as it does for every other command. A failure to write it is reported and
 * never fails the run.
 */
export function runReplayTestCommandProgress(
  reporters: ReplayTestReporter[],
  message: string,
  context: ReplayTestReporterContext,
): void {
  const writer = reporters.map(readCommandProgressWriter).find((found) => found !== undefined);
  try {
    if (writer) writer(message, context);
    else context.stderr.write(escapeTerminalText(`${message}\n`));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    try {
      context.stderr.write(escapeTerminalText(`Command progress failed: ${reason}\n`));
    } catch {
      // A stderr that cannot be written has nowhere left to report to.
    }
  }
}

function invokeReplayTestReporterLiveHook(
  reporter: ReplayTestReporter,
  event: ReplayTestReporterProgressEvent,
  context: ReplayTestReporterContext,
): unknown {
  switch (event.type) {
    case 'suite-start':
      return reporter.onSuiteStart?.(event.suite, context);
    case 'test-start':
      return reporter.onTestStart?.(event.test, context);
    case 'test-step':
      return reporter.onTestStep?.(event.test, context);
    case 'test-result':
      return reporter.onTestResult?.(event.test, context);
  }
}

function reportReplayTestReporterHookError(
  reporter: ReplayTestReporter,
  hookName: ReplayTestReporterLiveHook,
  context: ReplayTestReporterContext,
  error: unknown,
): void {
  const message = error instanceof Error ? error.message : String(error);
  context.stderr.write(
    escapeTerminalText(`Reporter ${reporter.name} ${String(hookName)} failed: ${message}\n`),
  );
}

export function getReplayTestReporterExitCode(
  reporters: ReplayTestReporter[],
  suite: ReplaySuiteResult,
): number {
  let exitCode = getReplayTestExitCode(suite);
  for (const reporter of reporters) {
    const reporterExitCode = reporter.getExitCode?.(suite);
    if (reporterExitCode === undefined) continue;
    if (!Number.isInteger(reporterExitCode) || reporterExitCode < 0 || reporterExitCode > 255) {
      throw new AppError(
        'INVALID_ARGS',
        `Test reporter ${reporter.name} getExitCode must return an integer from 0 to 255 or undefined.`,
      );
    }
    exitCode = Math.max(exitCode, reporterExitCode);
  }
  return exitCode;
}

async function resolveReplayTestReporter(
  spec: ReplayTestReporterSpec,
): Promise<ReplayTestReporter> {
  if (spec.kind === 'custom') {
    return await createCustomReplayTestReporter(spec);
  }
  if (spec.name === 'default') return createDefaultReplayTestReporter();
  return createJunitReplayTestReporter(spec.outputPath);
}
