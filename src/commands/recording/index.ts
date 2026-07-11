import type { RecordOptions } from '../../client/client-types.ts';
import { RECORDING_EXPORT_QUALITIES } from '../../core/recording-export-quality.ts';
import { RECORDING_SCOPE_VALUES } from '../../contracts/recording-scope.ts';
import { AppError } from '../../kernel/errors.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
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
    recordingScope: enumField(RECORDING_SCOPE_VALUES),
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

export const recordCommandDefinition = defineExecutableCommand(
  recordCommandMetadata,
  (client, input) => client.recording.record(input as RecordOptions),
);

export const traceCommandDefinition = defineExecutableCommand(
  traceCommandMetadata,
  (client, input) => client.recording.trace(input),
);

const recordCliSchema = {
  usageOverride:
    'record start [path] [--scope <app|device|system>] [--fps <n>] [--max-size <px>] [--quality <medium|high>] [--hide-touches] | record stop',
  listUsageOverride: 'record start [path] | record stop',
  helpDescription:
    'Start/stop screen recording. The default --scope app requires an active app session from open <app>; use --scope device/system to explicitly request whole-screen recording where the selected backend supports it. Android record start publishes a durable device manifest, recordings longer than the 180s adb screenrecord limit are returned as multiple MP4 chunks while the daemon stays alive, and daemon-restart recovery uses only manifest-owned chunks. Use --max-size to limit dimensions and --quality to choose medium or high export quality',
  summary: 'Start or stop screen recording',
  positionalArgs: ['start|stop', 'path?'],
  allowedFlags: ['recordingScope', 'fps', 'screenshotMaxSize', 'quality', 'hideTouches'],
} as const satisfies CommandSchemaOverride;

const traceCliSchema = {
  usageOverride: 'trace start <path> | trace stop <path>',
  listUsageOverride: 'trace start <path> | trace stop <path>',
  helpDescription:
    'Start/stop trace log capture; when an artifact path is requested, pass the same positional path to start and stop',
  summary: 'Start or stop trace capture',
  positionalArgs: ['start|stop', 'path?'],
} as const satisfies CommandSchemaOverride;

export const recordCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readRecordingAction(positionals[0], RECORD_COMMAND_NAME),
  path: positionals[1],
  fps: flags.fps,
  maxSize: flags.screenshotMaxSize,
  quality: flags.quality as RecordOptions['quality'],
  hideTouches: flags.hideTouches,
  recordingScope: flags.recordingScope,
});

export const traceCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readRecordingAction(positionals[0], TRACE_COMMAND_NAME),
  path: positionals[1],
});

export const recordDaemonWriter: DaemonWriter = direct(RECORD_COMMAND_NAME, (input) =>
  recordingPositionals(input as RecordOptions),
);

export const traceDaemonWriter: DaemonWriter = direct(TRACE_COMMAND_NAME, (input) =>
  recordingPositionals(input as RecordOptions),
);

const recordCommandFacet = defineCommandFacet({
  name: RECORD_COMMAND_NAME,
  metadata: recordCommandMetadata,
  definition: recordCommandDefinition,
  cliSchema: recordCliSchema,
  cliReader: recordCliReader,
  daemonWriter: recordDaemonWriter,
  cliOutputFormatter: recordingCliOutputFormatters.record,
});

const traceCommandFacet = defineCommandFacet({
  name: TRACE_COMMAND_NAME,
  metadata: traceCommandMetadata,
  definition: traceCommandDefinition,
  cliSchema: traceCliSchema,
  cliReader: traceCliReader,
  daemonWriter: traceDaemonWriter,
});

export const recordingCommandFamily = defineCommandFamilyFromFacets({
  name: 'recording',
  commands: [recordCommandFacet, traceCommandFacet],
});

function recordingPositionals(input: RecordOptions): string[] {
  return [input.action, ...optionalString(input.path)];
}

function readRecordingAction(value: string | undefined, command: string): 'start' | 'stop' {
  if (value === 'start' || value === 'stop') return value;
  throw new AppError('INVALID_ARGS', `${command} requires start|stop`);
}
