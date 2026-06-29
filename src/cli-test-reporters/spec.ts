import { AppError } from '../utils/errors.ts';

export type BuiltInReplayTestReporterName = 'default' | 'junit';

export type ReplayTestReporterSpec =
  | {
      kind: 'builtin';
      name: 'default';
      raw: string;
      options?: undefined;
    }
  | {
      kind: 'builtin';
      name: 'junit';
      raw: string;
      options: { output: string };
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
    specs.push(parseReplayTestReporterSpec(['junit', { output: options.reportJunit }]));
  }

  return specs;
}

export function parseReplayTestReporterSpec(
  spec: string | [string, unknown],
): ReplayTestReporterSpec {
  if (Array.isArray(spec)) {
    return parseTupleReplayTestReporterSpec(spec, JSON.stringify(spec));
  }

  const trimmed = spec.trim();
  if (!trimmed) {
    throw new AppError('INVALID_ARGS', 'Test reporter spec cannot be empty.');
  }

  if (trimmed.startsWith('[')) {
    return parseJsonTupleReplayTestReporterSpec(trimmed);
  }

  const { name, value } = splitReplayTestReporterSpec(trimmed);
  if (isCustomReplayTestReporterName(name)) {
    return {
      kind: 'custom',
      modulePath: name,
      raw: trimmed,
      options: readCustomReporterOptions(name, value),
    };
  }

  return parseBuiltInReplayTestReporterSpec(name, value, trimmed);
}

function parseJsonTupleReplayTestReporterSpec(spec: string): ReplayTestReporterSpec {
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
  return parseTupleReplayTestReporterSpec(parsed, spec);
}

function parseTupleReplayTestReporterSpec(tuple: unknown[], raw: string): ReplayTestReporterSpec {
  const [name, options] = tuple;
  if (typeof name !== 'string' || name.trim().length === 0) {
    throw new AppError(
      'INVALID_ARGS',
      'Reporter tuple first entry must be a reporter name or path.',
    );
  }
  if (tuple.length > 2) {
    throw new AppError('INVALID_ARGS', 'Reporter tuple must contain [nameOrPath, options].');
  }
  const reporterName = name.trim();
  if (isCustomReplayTestReporterName(reporterName)) {
    return { kind: 'custom', modulePath: reporterName, raw, options };
  }
  return parseBuiltInReplayTestReporterSpec(reporterName, options, raw);
}

function parseBuiltInReplayTestReporterSpec(
  name: string,
  value: unknown,
  raw: string,
): ReplayTestReporterSpec {
  if (name === 'default') {
    if (value !== undefined) {
      throw new AppError('INVALID_ARGS', 'The default test reporter does not accept options.');
    }
    return { kind: 'builtin', name, raw };
  }

  if (name === 'junit') {
    return { kind: 'builtin', name, raw, options: readJunitReporterOptions(value) };
  }

  throw new AppError(
    'INVALID_ARGS',
    `Unknown test reporter "${name}". Built-in reporters: default, junit:<path>. Custom reporters must be file paths.`,
  );
}

function readJunitReporterOptions(value: unknown): { output: string } {
  if (typeof value === 'string' && value.trim().length > 0) {
    return { output: value };
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const output =
      (value as Record<string, unknown>).output ?? (value as Record<string, unknown>).path;
    if (typeof output === 'string' && output.trim().length > 0) {
      return { output };
    }
  }
  throw new AppError(
    'INVALID_ARGS',
    'The junit test reporter requires an output path. Use --reporter junit:<path>.',
  );
}

function readCustomReporterOptions(modulePath: string, value: string | undefined): unknown {
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
