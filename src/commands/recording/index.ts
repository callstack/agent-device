import type { RecordOptions } from '@agent-device/contracts/client';
import {
  RETIRED_SCREENSHOT_MAX_SIZE,
  validateNoRetiredScreenshotMaxSize,
} from '@agent-device/contracts/capture';
import {
  RECORDING_EXPORT_QUALITIES,
  RECORDING_SCOPE_VALUES,
} from '@agent-device/contracts/recording';
import { AppError } from '@agent-device/kernel/errors';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { commonInputFromFlags, direct, optionalString } from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import {
  booleanField,
  enumField,
  integerField,
  requiredField,
  retiredField,
  stringField,
} from '../command-input.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { recordingCliOutputFormatters } from './output.ts';

const RECORD_COMMAND_NAME = 'record';
const TRACE_COMMAND_NAME = 'trace';
const RECORDING_ACTION_VALUES = ['start', 'stop'] as const;

const recordCommandDescription =
  'Start or stop a screen recording for the active app session or, where supported, the selected device. Long Android recordings can return multiple video artifacts; HarmonyOS supports whole-screen recording on physical devices.';
const traceCommandDescription =
  'Start or stop trace-log capture and return the resulting artifact when capture ends. Use the same artifact path for the matching start and stop requests when an explicit path is required.';

export const recordCommandMetadata = defineFieldCommandMetadata(
  RECORD_COMMAND_NAME,
  recordCommandDescription,
  {
    action: requiredField(enumField(RECORDING_ACTION_VALUES)),
    path: stringField(),
    fps: integerField(),
    maxSize: retiredField(RETIRED_SCREENSHOT_MAX_SIZE.migration.record),
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
    'record start [path] [--scope <app|device|system>] [--fps <n>] [--quality <medium|high>] [--hide-touches] | record stop',
  listUsageOverride: 'record start [path] | record stop',
  positionalArgs: ['start|stop', 'path?'],
  allowedFlags: ['recordingScope', 'fps', 'quality', 'hideTouches'],
} as const satisfies CommandSchemaOverride;

const traceCliSchema = {
  usageOverride: 'trace start <path> | trace stop <path>',
  listUsageOverride: 'trace start <path> | trace stop <path>',
  positionalArgs: ['start|stop', 'path?'],
} as const satisfies CommandSchemaOverride;

export const recordCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readRecordingAction(positionals[0], RECORD_COMMAND_NAME),
  path: positionals[1],
  fps: flags.fps,
  quality: flags.quality as RecordOptions['quality'],
  hideTouches: flags.hideTouches,
  recordingScope: flags.recordingScope,
});

export const traceCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readRecordingAction(positionals[0], TRACE_COMMAND_NAME),
  path: positionals[1],
});

const recordDirectWriter = direct(RECORD_COMMAND_NAME, (input) =>
  recordingPositionals(input as RecordOptions),
);

export const recordDaemonWriter: DaemonWriter = (input) => {
  validateNoRetiredScreenshotMaxSize('record', input);
  return recordDirectWriter(input);
};

export const traceDaemonWriter: DaemonWriter = direct(TRACE_COMMAND_NAME, (input) =>
  recordingPositionals(input as RecordOptions),
);

const recordCommandFacet = defineCommandFacet({
  name: RECORD_COMMAND_NAME,
  text: {
    summary: 'Start or stop screen recording',
    cliDetail:
      'The default --scope app requires an active app session from open <app>; use --scope device/system to explicitly request whole-screen recording where the selected backend supports it. Android record start publishes a durable device manifest, recordings longer than the 180s adb screenrecord limit are returned as multiple MP4 chunks while the daemon stays alive, and daemon-restart recovery uses only manifest-owned chunks. HarmonyOS supports whole-screen recording on physical devices only: use --scope device/system; --fps, --quality, and --hide-touches are unsupported. Use --quality to choose medium or high export quality on supported backends.',
  },
  metadata: recordCommandMetadata,
  definition: recordCommandDefinition,
  cliSchema: recordCliSchema,
  cliReader: recordCliReader,
  daemonWriter: recordDaemonWriter,
  cliOutputFormatter: recordingCliOutputFormatters.record,
});

const traceCommandFacet = defineCommandFacet({
  name: TRACE_COMMAND_NAME,
  text: {
    summary: 'Start or stop trace capture',
    cliDetail: 'Pass that path as the same positional argument to start and stop.',
  },
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
