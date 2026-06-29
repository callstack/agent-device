import { AppError } from '../utils/errors.ts';

export type BuiltInReplayTestReporterName = 'default' | 'junit';

export type ReplayTestReporterSpec =
  | {
      kind: 'builtin';
      name: BuiltInReplayTestReporterName;
      raw: string;
      options?: unknown;
    }
  | {
      kind: 'custom';
      modulePath: string;
      raw: string;
      options: unknown;
    };

export function buildReplayTestReporterSpecs(options: {
  reporters?: string[];
  reportJunit?: string;
  json?: boolean;
}): ReplayTestReporterSpec[] {
  const specs =
    options.reporters && options.reporters.length > 0
      ? options.reporters.map(parseReplayTestReporterSpec)
      : options.json
        ? []
        : [parseReplayTestReporterSpec('default')];

  if (options.reportJunit) {
    specs.push(parseReplayTestReporterSpec(`junit:${options.reportJunit}`));
  }

  return specs;
}

export function parseReplayTestReporterSpec(spec: string): ReplayTestReporterSpec {
  const trimmed = spec.trim();
  if (!trimmed) {
    throw new AppError('INVALID_ARGS', 'Test reporter spec cannot be empty.');
  }

  if (trimmed.startsWith('[')) {
    const [name, options] = readReporterTuple(trimmed);
    return createReporterSpec(name, options, trimmed);
  }

  const { name, value } = splitReplayTestReporterSpec(trimmed);
  return createReporterSpec(name, readShorthandOptions(name, value), trimmed);
}

function readReporterTuple(spec: string): [string, unknown] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError('INVALID_ARGS', `Invalid JSON reporter tuple: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new AppError('INVALID_ARGS', 'JSON reporter spec must be an array.');
  }
  const [name, options] = parsed;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new AppError(
      'INVALID_ARGS',
      'Reporter tuple first entry must be a reporter name or path.',
    );
  }
  if (parsed.length > 2) {
    throw new AppError('INVALID_ARGS', 'Reporter tuple must contain [nameOrPath, options].');
  }
  return [name.trim(), options];
}

function createReporterSpec(name: string, options: unknown, raw: string): ReplayTestReporterSpec {
  if (isCustomReplayTestReporterName(name)) {
    return { kind: 'custom', modulePath: name, raw, options };
  }
  if (name === 'default' || name === 'junit') {
    return options === undefined
      ? { kind: 'builtin', name, raw }
      : { kind: 'builtin', name, raw, options };
  }

  throw new AppError(
    'INVALID_ARGS',
    `Unknown test reporter "${name}". Built-in reporters: default, junit:<path>. Custom reporters must be file paths.`,
  );
}

function readShorthandOptions(modulePath: string, value: string | undefined): unknown {
  if (value === undefined) return undefined;
  if (!value.startsWith('{')) return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new AppError(
      'INVALID_ARGS',
      `Invalid JSON options for custom test reporter ${modulePath}: ${message}`,
    );
  }
}

function splitReplayTestReporterSpec(spec: string): { name: string; value?: string } {
  const optionsSeparator = spec.indexOf(':{');
  if (optionsSeparator >= 0) {
    return {
      name: spec.slice(0, optionsSeparator).trim(),
      value: spec.slice(optionsSeparator + 1),
    };
  }

  const separatorIndex = spec.indexOf(':');
  if (separatorIndex < 0) return { name: spec.trim() };
  return {
    name: spec.slice(0, separatorIndex).trim(),
    value: spec.slice(separatorIndex + 1),
  };
}

function isCustomReplayTestReporterName(name: string): boolean {
  return (
    name.startsWith('.') || name.startsWith('/') || name.startsWith('~') || name.startsWith('file:')
  );
}
