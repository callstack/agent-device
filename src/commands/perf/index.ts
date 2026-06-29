import type { PerfOptions } from '../../client-types.ts';
import { AppError } from '../../kernel/errors.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { enumField, stringField } from '../command-input.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import {
  isPerfAction,
  isPerfArea,
  isPerfKind,
  isPerfSubject,
  PERF_ACTION_ERROR_MESSAGE,
  PERF_ACTION_VALUES,
  PERF_AREA_ERROR_MESSAGE,
  PERF_AREA_VALUES,
  PERF_KIND_ERROR_MESSAGE,
  PERF_KIND_VALUES,
  PERF_SUBJECT_ERROR_MESSAGE,
  PERF_SUBJECT_VALUES,
  type PerfAction,
  type PerfArea,
  type PerfKind,
  type PerfSubject,
} from './perf-command-contract.ts';
import { commonInputFromFlags, direct, optionalString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { perfCliOutputFormatters } from './output.ts';

const PERF_COMMAND_NAME = 'perf';

const perfCommandDescription = 'Show session performance, frame health, and memory diagnostics.';

export const perfCommandMetadata = defineFieldCommandMetadata(
  PERF_COMMAND_NAME,
  perfCommandDescription,
  {
    area: enumField(PERF_AREA_VALUES),
    subject: enumField(PERF_SUBJECT_VALUES),
    action: enumField(PERF_ACTION_VALUES),
    kind: enumField(PERF_KIND_VALUES),
    template: stringField('xctrace template name, for example Time Profiler.'),
    out: stringField('Output artifact path.'),
    tracePath: stringField('Existing .trace path to report, defaults to the latest session trace.'),
  },
);

export const perfCommandDefinition = defineExecutableCommand(perfCommandMetadata, (client, input) =>
  client.observability.perf(input),
);

const perfCliSchema = {
  usageOverride:
    'perf metrics --json\n  agent-device perf frames --json\n  agent-device perf memory sample --json\n  agent-device perf memory snapshot [--kind android-hprof|memgraph] [--out <path>]\n  agent-device perf cpu profile start --kind xctrace [--template <name>] --out <profile.trace>\n  agent-device perf cpu profile stop --kind xctrace --out <profile.trace>\n  agent-device perf cpu profile report --kind xctrace --out <report.json>\n  agent-device perf trace start|stop --kind xctrace [--template <name>] --out <path>\n  agent-device perf cpu profile start --kind simpleperf --out <cpu.perf.data>\n  agent-device perf cpu profile stop --kind simpleperf\n  agent-device perf cpu profile report --kind simpleperf --out <cpu-report.json>\n  agent-device perf trace start|stop --kind perfetto [--out <path>]',
  listUsageOverride: 'perf',
  helpDescription:
    'Show session performance metrics, focused frame/jank health, memory diagnostics artifacts, Apple xctrace artifacts, or Android native Simpleperf/Perfetto artifacts. Prefer explicit perf metrics --json for first-pass startup/CPU/memory data. For CPU profiles, start/stop write the raw artifact and report writes a compact .json summary; include report after simpleperf stop when the task needs agent-readable native CPU evidence. Bare perf and metrics remain aliases. Native perf output is agent evidence: compact state, artifact path, and size only; raw profiles/traces stay on disk.',
  summary: 'Check runtime metrics, frames, memory, CPU profiles, or native trace artifacts',
  positionalArgs: ['area?', 'subjectOrAction?', 'action?'],
  allowedFlags: ['kind', 'perfTemplate', 'out'],
} as const satisfies CommandSchemaOverride;

export const perfCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  ...readPerfPositionals(positionals, {
    kind: readPerfKindFlag(flags.kind),
    template: flags.perfTemplate,
    out: flags.out,
  }),
});

export const perfDaemonWriter: DaemonWriter = direct(PERF_COMMAND_NAME, (input) =>
  perfPositionals(input as PerfOptions),
);

const perfCommandFacet = defineCommandFacet({
  name: PERF_COMMAND_NAME,
  metadata: perfCommandMetadata,
  definition: perfCommandDefinition,
  cliSchema: perfCliSchema,
  cliReader: perfCliReader,
  daemonWriter: perfDaemonWriter,
  cliOutputFormatter: perfCliOutputFormatters.perf,
});

export const perfCommandFamily = defineCommandFamilyFromFacets({
  name: 'perf',
  commands: [perfCommandFacet],
});

function perfPositionals(input: PerfOptions): string[] {
  const area = input.area ?? (input.action ? 'metrics' : undefined);
  if (area === 'cpu') {
    return nativePerfPositionals(
      [
        ...optionalString(area),
        ...optionalString(input.subject),
        ...optionalString(input.action),
        ...optionalString(input.kind),
      ],
      input,
    );
  }
  if (area === 'trace') {
    return nativePerfPositionals(
      [...optionalString(area), ...optionalString(input.action), ...optionalString(input.kind)],
      input,
    );
  }
  return [...optionalString(area), ...optionalString(input.action)];
}

function nativePerfPositionals(base: string[], input: PerfOptions): string[] {
  const positionals = [...base];
  if (input.template || input.out || input.tracePath) {
    positionals.push(input.template ?? '');
  }
  if (input.out || input.tracePath) {
    positionals.push(input.out ?? '');
  }
  if (input.tracePath) {
    positionals.push(input.tracePath);
  }
  return positionals;
}

function readPerfPositionals(
  positionals: string[],
  flags: Pick<PerfOptions, 'kind' | 'template' | 'out'> = {},
): Pick<PerfOptions, 'area' | 'subject' | 'action' | 'kind' | 'template' | 'out'> {
  if (positionals[0] !== undefined && positionals[1] === undefined) {
    const action = readPerfAction(positionals[0], { allowUndefined: true });
    if (action) return { action, kind: readPerfKind(flags.kind), out: flags.out };
  }
  const area = readPerfArea(positionals[0]);
  if (area === 'cpu') {
    return {
      area,
      subject: readPerfSubject(positionals[1]),
      action: readPerfAction(positionals[2]),
      kind: readPerfKind(flags.kind),
      template: flags.template,
      out: flags.out,
    };
  }
  if (area === 'trace') {
    return {
      area,
      action: readPerfAction(positionals[1]),
      kind: readPerfKind(flags.kind),
      template: flags.template,
      out: flags.out,
    };
  }
  return {
    area,
    action: readPerfAction(positionals[1]),
    kind: readPerfKind(flags.kind),
    out: flags.out,
  };
}

function readPerfArea(value: string | undefined): PerfArea | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (isPerfArea(normalized)) return normalized;
  throw new AppError('INVALID_ARGS', PERF_AREA_ERROR_MESSAGE);
}

function readPerfAction(
  value: string | undefined,
  options: { allowUndefined?: boolean } = {},
): PerfAction | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (isPerfAction(normalized)) return normalized;
  if (options.allowUndefined) return undefined;
  throw new AppError('INVALID_ARGS', PERF_ACTION_ERROR_MESSAGE);
}

function readPerfSubject(value: string | undefined): PerfSubject {
  const normalized = value?.toLowerCase();
  if (normalized !== undefined && isPerfSubject(normalized)) return normalized;
  throw new AppError('INVALID_ARGS', PERF_SUBJECT_ERROR_MESSAGE);
}

function readPerfKind(value: string | undefined): PerfKind | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (isPerfKind(normalized)) return normalized;
  throw new AppError('INVALID_ARGS', PERF_KIND_ERROR_MESSAGE);
}

function readPerfKindFlag(value: unknown): PerfKind | undefined {
  return typeof value === 'string' ? readPerfKind(value) : undefined;
}
