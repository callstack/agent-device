import type { ReplaySuiteResult } from '../daemon/types.ts';
import { AppError } from '../utils/errors.ts';
import { createCustomReplayTestReporter } from './custom.ts';
import { createDefaultReplayTestReporter } from './default.ts';
import { getReplayTestExitCode } from './format.ts';
import { createJunitReplayTestReporter } from './junit.ts';
import {
  buildReplayTestReporterSpecs,
  type BuiltInReplayTestReporterName,
  type ReplayTestReporterSpec,
} from './spec.ts';
import type {
  ReplayTestReporter,
  ReplayTestReporterContext,
  ReplayTestReporterFactory,
} from './types.ts';

const BUILT_IN_REPLAY_TEST_REPORTERS = {
  default: createDefaultReplayTestReporter,
  junit: createJunitReplayTestReporter,
} satisfies Record<BuiltInReplayTestReporterName, ReplayTestReporterFactory>;

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

  const factory = BUILT_IN_REPLAY_TEST_REPORTERS[spec.name];
  if (!factory) {
    throw new AppError('INVALID_ARGS', `Unknown built-in test reporter "${spec.name}".`);
  }
  return await factory(spec.options, { spec: spec.raw, modulePath: spec.name });
}
