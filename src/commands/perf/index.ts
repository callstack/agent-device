import type { PerfOptions } from '@agent-device/contracts/client';
import { AppError } from '@agent-device/kernel/errors';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { enumField, requiredField, stringField } from '../command-input.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import {
  isPerfAction,
  isPerfArea,
  isPerfKind,
  isRemovedAggregatePerfToken,
  isPerfSubject,
  PERF_ACTION_ERROR_MESSAGE,
  PERF_ACTION_VALUES,
  PERF_AGGREGATE_REMOVED_ERROR_MESSAGE,
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

const perfCommandDescription =
  'Collect frame health, memory diagnostics, and platform profiling artifacts with compact agent-readable summaries.';

export const perfCommandMetadata = defineFieldCommandMetadata(
  PERF_COMMAND_NAME,
  perfCommandDescription,
  {
    area: requiredField(enumField(PERF_AREA_VALUES)),
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
    'perf frames --json\n  agent-device perf memory sample --json\n  agent-device perf memory snapshot [--kind android-hprof|memgraph] [--out <path>]\n  agent-device perf cpu profile start --kind xctrace [--template <name>] --out <profile.trace>\n  agent-device perf cpu profile stop --kind xctrace --out <profile.trace>\n  agent-device perf cpu profile report --kind xctrace --out <report.json>\n  agent-device perf trace start|stop --kind xctrace [--template <name>] --out <path>\n  agent-device perf cpu profile start --kind simpleperf --out <cpu.perf.data>\n  agent-device perf cpu profile stop --kind simpleperf\n  agent-device perf cpu profile report --kind simpleperf --out <cpu-report.json>\n  agent-device perf trace start|stop --kind perfetto [--out <path>]\n\n  Aggregate perf was removed in 0.21. Use one of the explicit forms above.',
  listUsageOverride: 'perf',
  positionalArgs: ['area', 'subjectOrAction?', 'action?'],
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
  text: {
    summary: 'Check frames, memory, or native profiles',
    cliDetail:
      'Use perf frames for bounded frame-health evidence and perf memory sample for a compact process-memory reading. Apple xctrace and Android Simpleperf/Perfetto captures keep raw artifacts on disk; report produces bounded agent-readable evidence. For React render internals, use agent-device react-devtools.',
    mcpDetail:
      'For CPU profiles, start and stop write the raw artifact while report writes a compact summary; request the report when the task needs readable native CPU evidence. Profiling output is evidence only: compact state, artifact path, and size.',
  },
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
  const area = input.area;
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
  const action = readPerfAction(positionals[1]);
  const kind = readPerfKind(flags.kind);
  validateObservationPerfFlags(area, action, kind, flags.out);
  return {
    area,
    action,
    kind,
    out: flags.out,
  };
}

function validateObservationPerfFlags(
  area: 'frames' | 'memory',
  action: PerfAction | undefined,
  kind: PerfKind | undefined,
  out: string | undefined,
): void {
  if (area === 'frames') {
    if (kind !== undefined) {
      throw new AppError('INVALID_ARGS', '--kind is only supported with perf memory snapshot');
    }
    if (out !== undefined) {
      throw new AppError(
        'INVALID_ARGS',
        '--out is only supported with perf memory snapshot, perf cpu profile, or perf trace',
      );
    }
  }
  if (area === 'memory') {
    if (action !== 'snapshot' && kind !== undefined) {
      throw new AppError('INVALID_ARGS', '--kind is only supported with perf memory snapshot');
    }
    if (action !== 'snapshot' && out !== undefined) {
      throw new AppError('INVALID_ARGS', '--out is only supported with perf memory snapshot');
    }
  }
}

function readPerfArea(value: string | undefined): PerfArea {
  const normalized = value?.toLowerCase();
  if (isRemovedAggregatePerfToken(normalized)) {
    throw new AppError('INVALID_ARGS', PERF_AGGREGATE_REMOVED_ERROR_MESSAGE);
  }
  if (isPerfArea(normalized)) return normalized;
  throw new AppError('INVALID_ARGS', PERF_AREA_ERROR_MESSAGE);
}

function readPerfAction(value: string | undefined): PerfAction | undefined {
  if (value === undefined) return undefined;
  const normalized = value.toLowerCase();
  if (isPerfAction(normalized)) return normalized;
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
