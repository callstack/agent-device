import { AppError } from '../kernel/errors.ts';

export type ReplayTestReporterSpec =
  | {
      kind: 'builtin';
      name: 'default';
      raw: string;
    }
  | {
      kind: 'builtin';
      name: 'junit';
      raw: string;
      outputPath?: string;
    }
  | {
      kind: 'custom';
      modulePath: string;
      raw: string;
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

  if (isCustomReplayTestReporterName(trimmed)) {
    return { kind: 'custom', modulePath: trimmed, raw: trimmed };
  }

  const { name, value } = splitReplayTestReporterSpec(trimmed);
  if (name === 'default') {
    if (value !== undefined) {
      throw new AppError('INVALID_ARGS', 'The default test reporter does not accept options.');
    }
    return { kind: 'builtin', name, raw: trimmed };
  }
  if (name === 'junit') {
    return value === undefined
      ? { kind: 'builtin', name, raw: trimmed }
      : { kind: 'builtin', name, raw: trimmed, outputPath: value };
  }

  throw new AppError(
    'INVALID_ARGS',
    `Unknown test reporter "${name}". Built-in reporters: default, junit:<path>. Custom reporters must be file paths.`,
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

function isCustomReplayTestReporterName(name: string): boolean {
  return (
    name.startsWith('.') || name.startsWith('/') || name.startsWith('~') || name.startsWith('file:')
  );
}
