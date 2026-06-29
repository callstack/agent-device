import type { ReplaySuiteResult } from '../daemon/types.ts';
import { createCustomReplayTestReporter } from './custom.ts';
import { createDefaultReplayTestReporter } from './default.ts';
import { getReplayTestExitCode } from './format.ts';
import { createJunitReplayTestReporter } from './junit.ts';
import { buildReplayTestReporterSpecs, type ReplayTestReporterSpec } from './spec.ts';
import type { ReplayTestReporter, ReplayTestReporterContext } from './types.ts';

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

export function getReplayTestReporterExitCode(
  reporters: ReplayTestReporter[],
  suite: ReplaySuiteResult,
): number {
  for (const reporter of reporters) {
    const exitCode = reporter.getExitCode?.(suite);
    if (exitCode !== undefined) return exitCode;
  }
  return getReplayTestExitCode(suite);
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
