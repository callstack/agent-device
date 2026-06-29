import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '../kernel/errors.ts';
import type { ReplayTestReporter, ReplayTestReporterFactory } from './types.ts';
import type { ReplayTestReporterSpec } from './spec.ts';

type CustomReporterModule = {
  default?: unknown;
  createReporter?: unknown;
  reporter?: unknown;
};

const OPTIONAL_REPORTER_HOOKS = [
  'onProgress',
  'onSuiteEnd',
  'getExitCode',
] as const satisfies readonly (keyof ReplayTestReporter)[];

export async function createCustomReplayTestReporter(
  spec: Extract<ReplayTestReporterSpec, { kind: 'custom' }>,
): Promise<ReplayTestReporter> {
  const modulePath = resolveCustomReporterModulePath(spec.modulePath);
  const module = await importCustomReporterModule(modulePath);
  const factory = readCustomReporterFactory(module, spec.modulePath);
  const reporter = await factory({ spec: spec.raw, modulePath });
  return validateCustomReplayTestReporter(reporter, spec.modulePath);
}

function readCustomReporterFactory(
  module: CustomReporterModule,
  modulePath: string,
): ReplayTestReporterFactory {
  const exported = module.createReporter ?? module.default ?? module.reporter;
  if (!exported) {
    throw new AppError(
      'INVALID_ARGS',
      `Custom test reporter ${modulePath} must export default, createReporter, or reporter.`,
    );
  }
  return typeof exported === 'function'
    ? (exported as ReplayTestReporterFactory)
    : () => exported as ReplayTestReporter;
}

function resolveCustomReporterModulePath(modulePath: string): string {
  if (modulePath.startsWith('file:')) return modulePath;
  const expandedPath = modulePath.startsWith('~/')
    ? path.join(os.homedir(), modulePath.slice(2))
    : modulePath;
  return path.resolve(process.cwd(), expandedPath);
}

async function importCustomReporterModule(modulePath: string): Promise<CustomReporterModule> {
  try {
    const href = modulePath.startsWith('file:') ? modulePath : pathToFileURL(modulePath).href;
    return (await import(href)) as CustomReporterModule;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(
      'INVALID_ARGS',
      `Failed to load custom test reporter ${modulePath}: ${message}`,
    );
  }
}

function validateCustomReplayTestReporter(
  reporter: unknown,
  modulePath: string,
): ReplayTestReporter {
  if (!reporter || typeof reporter !== 'object') {
    throw new AppError(
      'INVALID_ARGS',
      `Custom test reporter ${modulePath} must export a reporter object or factory.`,
    );
  }
  const candidate = reporter as Partial<ReplayTestReporter>;
  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) {
    throw new AppError('INVALID_ARGS', `Custom test reporter ${modulePath} must define name.`);
  }
  for (const hook of OPTIONAL_REPORTER_HOOKS) {
    if (candidate[hook] === undefined || typeof candidate[hook] === 'function') continue;
    throw new AppError(
      'INVALID_ARGS',
      `Custom test reporter ${modulePath} ${hook} must be a function.`,
    );
  }
  return candidate as ReplayTestReporter;
}
