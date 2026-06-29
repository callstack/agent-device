import type { ReplaySuiteResult } from '../daemon/types.ts';
import { AppError } from '../utils/errors.ts';
import { createDefaultReplayTestReporter } from './default.ts';
import { getReplayTestExitCode } from './format.ts';
import { createJunitReplayTestReporter } from './junit.ts';
import type { ReplayTestReporter, ReplayTestReporterContext } from './types.ts';

export function resolveReplayTestReporters(options: {
  reporters?: string[];
  reportJunit?: string;
  json?: boolean;
}): ReplayTestReporter[] {
  const specs =
    options.reporters && options.reporters.length > 0
      ? [...options.reporters]
      : options.json
        ? []
        : ['default'];

  if (options.reportJunit) {
    specs.push(`junit:${options.reportJunit}`);
  }

  return specs.map(resolveReplayTestReporter);
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

function resolveReplayTestReporter(spec: string): ReplayTestReporter {
  const { name, value } = splitReplayTestReporterSpec(spec);
  if (name === 'default') {
    if (value) {
      throw new AppError('INVALID_ARGS', 'The default test reporter does not accept options.');
    }
    return createDefaultReplayTestReporter();
  }
  if (name === 'junit') {
    if (!value) {
      throw new AppError(
        'INVALID_ARGS',
        'The junit test reporter requires an output path. Use --reporter junit:<path>.',
      );
    }
    return createJunitReplayTestReporter(value);
  }

  throw new AppError(
    'INVALID_ARGS',
    `Unknown test reporter "${name}". Built-in reporters: default, junit:<path>.`,
  );
}

function splitReplayTestReporterSpec(spec: string): { name: string; value?: string } {
  const separatorIndex = spec.indexOf(':');
  if (separatorIndex < 0) return { name: spec.trim() };
  return {
    name: spec.slice(0, separatorIndex).trim(),
    value: spec.slice(separatorIndex + 1),
  };
}
