import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { AppError } from '../utils/errors.ts';
import type {
  ReplayTestReporter,
  ReplayTestReporterFactory,
  ReplayTestReporterLoadContext,
} from './types.ts';

type CustomReporterModule = {
  default?: unknown;
  createReporter?: unknown;
  reporter?: unknown;
};

type CustomReporterSpec = {
  modulePath: string;
  options: unknown;
};

export function isCustomReplayTestReporterSpec(spec: string): boolean {
  const modulePath = readCustomReporterModulePath(spec);
  return (
    modulePath.startsWith('.') ||
    modulePath.startsWith('/') ||
    modulePath.startsWith('~') ||
    modulePath.startsWith('file:')
  );
}

export async function createCustomReplayTestReporter(spec: string): Promise<ReplayTestReporter> {
  const customSpec = splitCustomReplayTestReporterSpec(spec);
  const modulePath = resolveCustomReporterModulePath(customSpec.modulePath);
  const module = await importCustomReporterModule(modulePath);
  const exported = module.createReporter ?? module.default ?? module.reporter;
  if (!exported) {
    throw new AppError(
      'INVALID_ARGS',
      `Custom test reporter ${customSpec.modulePath} must export default, createReporter, or reporter.`,
    );
  }

  const reporter =
    typeof exported === 'function'
      ? await (exported as ReplayTestReporterFactory)(customSpec.options, {
          spec,
          modulePath,
        } satisfies ReplayTestReporterLoadContext)
      : exported;

  return validateCustomReplayTestReporter(reporter, customSpec.modulePath);
}

function splitCustomReplayTestReporterSpec(spec: string): CustomReporterSpec {
  const optionsSeparator = spec.indexOf(':{');
  if (optionsSeparator < 0) return { modulePath: spec.trim(), options: undefined };
  const modulePath = readCustomReporterModulePath(spec);
  const rawOptions = spec.slice(optionsSeparator + 1);
  if (!modulePath) {
    throw new AppError('INVALID_ARGS', 'Custom test reporter path cannot be empty.');
  }
  try {
    return { modulePath, options: JSON.parse(rawOptions) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(
      'INVALID_ARGS',
      `Invalid JSON options for custom test reporter ${modulePath}: ${message}`,
    );
  }
}

function readCustomReporterModulePath(spec: string): string {
  const optionsSeparator = spec.indexOf(':{');
  return (optionsSeparator < 0 ? spec : spec.slice(0, optionsSeparator)).trim();
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
  if (candidate.onProgress !== undefined && typeof candidate.onProgress !== 'function') {
    throw new AppError(
      'INVALID_ARGS',
      `Custom test reporter ${modulePath} onProgress must be a function.`,
    );
  }
  if (candidate.onSuiteEnd !== undefined && typeof candidate.onSuiteEnd !== 'function') {
    throw new AppError(
      'INVALID_ARGS',
      `Custom test reporter ${modulePath} onSuiteEnd must be a function.`,
    );
  }
  if (candidate.getExitCode !== undefined && typeof candidate.getExitCode !== 'function') {
    throw new AppError(
      'INVALID_ARGS',
      `Custom test reporter ${modulePath} getExitCode must be a function.`,
    );
  }
  return candidate as ReplayTestReporter;
}
