import type { ReplaySuiteResult } from '../../../daemon/types.ts';
import type { RequestProgressEvent } from '../../../request/progress.ts';
import { createCustomReplayTestReporter } from './custom.ts';
import { createDefaultReplayTestReporter } from './default.ts';
import { getReplayTestExitCode } from './format.ts';
import { createJunitReplayTestReporter } from './junit.ts';
import { toReplayTestReporterProgressEvent } from './progress.ts';
import { buildReplayTestReporterSpecs, type ReplayTestReporterSpec } from './spec.ts';
import type {
  ReplayTestReporter,
  ReplayTestReporterContext,
  ReplayTestReporterProgressEvent,
} from './types.ts';

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
  context.stderr.write(`Reporter ${reporter.name} ${String(hookName)} failed: ${message}\n`);
}

export function getReplayTestReporterExitCode(
  reporters: ReplayTestReporter[],
  suite: ReplaySuiteResult,
): number {
  let exitCode = getReplayTestExitCode(suite);
  for (const reporter of reporters) {
    const reporterExitCode = reporter.getExitCode?.(suite);
    if (reporterExitCode !== undefined) exitCode = Math.max(exitCode, reporterExitCode);
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
