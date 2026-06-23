import type { RecordOptions } from '../../client-types.ts';
import { RECORDING_EXPORT_QUALITIES } from '../../core/recording-export-quality.ts';
import { AppError } from '../../utils/errors.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { defineCommandFamily } from '../family/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  booleanField,
  enumField,
  integerField,
  requiredField,
  stringField,
} from '../command-input.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { commonInputFromFlags, direct, optionalString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { recordingCliOutputFormatters } from './output.ts';

const RECORD_COMMAND_NAME = 'record';
const TRACE_COMMAND_NAME = 'trace';
const RECORDING_ACTION_VALUES = ['start', 'stop'] as const;

const recordCommandDescription = 'Start or stop screen recording.';
const traceCommandDescription = 'Start or stop trace capture.';

export const recordCommandMetadata = defineFieldCommandMetadata(
  RECORD_COMMAND_NAME,
  recordCommandDescription,
  {
    action: requiredField(enumField(RECORDING_ACTION_VALUES)),
    path: stringField(),
    fps: integerField(),
    maxSize: integerField(),
    quality: enumField(RECORDING_EXPORT_QUALITIES),
    hideTouches: booleanField(),
  },
);

export const traceCommandMetadata = defineFieldCommandMetadata(
  TRACE_COMMAND_NAME,
  traceCommandDescription,
  {
    action: requiredField(enumField(RECORDING_ACTION_VALUES)),
    path: stringField(),
  },
);

const recordingCommandMetadata = [recordCommandMetadata, traceCommandMetadata] as const;

export const recordCommandDefinition = defineExecutableCommand(
  recordCommandMetadata,
  (client, input) => client.recording.record(input as RecordOptions),
);

export const traceCommandDefinition = defineExecutableCommand(
  traceCommandMetadata,
  (client, input) => client.recording.trace(input),
);

const recordingCommandDefinitions = [recordCommandDefinition, traceCommandDefinition] as const;

const recordCliSchema = {
  usageOverride:
    'record start [path] [--fps <n>] [--max-size <px>] [--quality <medium|high>] [--hide-touches] | record stop',
  listUsageOverride: 'record start [path] | record stop',
  helpDescription:
    'Start/stop screen recording; Android recordings longer than the 180s adb screenrecord limit are returned as multiple MP4 chunks. Use --max-size to limit dimensions and --quality to choose medium or high export quality',
  summary: 'Start or stop screen recording',
  positionalArgs: ['start|stop', 'path?'],
  allowedFlags: ['fps', 'screenshotMaxSize', 'quality', 'hideTouches'],
} as const satisfies CommandSchemaOverride;

const traceCliSchema = {
  usageOverride: 'trace start <path> | trace stop <path>',
  listUsageOverride: 'trace start <path> | trace stop <path>',
  helpDescription:
    'Start/stop trace log capture; when an artifact path is requested, pass the same positional path to start and stop',
  summary: 'Start or stop trace capture',
  positionalArgs: ['start|stop', 'path?'],
} as const satisfies CommandSchemaOverride;

const recordingCliSchemas = {
  [RECORD_COMMAND_NAME]: recordCliSchema,
  [TRACE_COMMAND_NAME]: traceCliSchema,
} as const satisfies Record<string, CommandSchemaOverride>;

export const recordCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readRecordingAction(positionals[0], RECORD_COMMAND_NAME),
  path: positionals[1],
  fps: flags.fps,
  maxSize: flags.screenshotMaxSize,
  quality: flags.quality as RecordOptions['quality'],
  hideTouches: flags.hideTouches,
});

export const traceCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readRecordingAction(positionals[0], TRACE_COMMAND_NAME),
  path: positionals[1],
});

const recordingCliReaders = {
  record: recordCliReader,
  trace: traceCliReader,
} satisfies Record<string, CliReader>;

export const recordDaemonWriter: DaemonWriter = direct(RECORD_COMMAND_NAME, (input) =>
  recordingPositionals(input as RecordOptions),
);

export const traceDaemonWriter: DaemonWriter = direct(TRACE_COMMAND_NAME, (input) =>
  recordingPositionals(input as RecordOptions),
);

const recordingDaemonWriters = {
  record: recordDaemonWriter,
  trace: traceDaemonWriter,
} satisfies Record<string, DaemonWriter>;

export const recordingCommandFamily = defineCommandFamily({
  name: 'recording',
  metadata: recordingCommandMetadata,
  definitions: recordingCommandDefinitions,
  cliSchemas: recordingCliSchemas,
  cliReaders: recordingCliReaders,
  daemonWriters: recordingDaemonWriters,
  cliOutputFormatters: recordingCliOutputFormatters,
});

function recordingPositionals(input: RecordOptions): string[] {
  return [input.action, ...optionalString(input.path)];
}

function readRecordingAction(value: string | undefined, command: string): 'start' | 'stop' {
  if (value === 'start' || value === 'stop') return value;
  throw new AppError('INVALID_ARGS', `${command} requires start|stop`);
}
