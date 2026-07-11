import type {
  AudioOptions,
  EventsOptions,
  LogsOptions,
  NetworkOptions,
} from '../../client/client-types.ts';
import { NETWORK_INCLUDE_MODES, type NetworkIncludeMode } from '../../kernel/contracts.ts';
import { AppError } from '../../kernel/errors.ts';
import { parseStringMember } from '../../utils/string-enum.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import { defineCommandFacet, defineCommandFamilyFromFacets } from '../family/types.ts';
import { booleanField, enumField, integerField, stringField } from '../command-input.ts';
import { defineExecutableCommand } from '../command-contract.ts';
import { defineFieldCommandMetadata } from '../field-command-contract.ts';
import { LOG_ACTION_VALUES, type LogAction } from './log-command-contract.ts';
import {
  commonInputFromFlags,
  direct,
  optionalCliNumber,
  optionalNumber,
  optionalString,
  request,
} from '../cli-grammar/common.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { observabilityCliOutputFormatters } from './output.ts';

const LOGS_COMMAND_NAME = 'logs';
const EVENTS_COMMAND_NAME = 'events';
const NETWORK_COMMAND_NAME = 'network';
const AUDIO_COMMAND_NAME = 'audio';
const NETWORK_ACTION_VALUES = ['dump', 'log'] as const;
const AUDIO_ACTION_VALUES = ['probe'] as const;
const AUDIO_PROBE_ACTION_VALUES = ['start', 'status', 'stop'] as const;

const logsCommandDescription = 'Manage session app logs.';
const eventsCommandDescription = 'Read the session event timeline.';
const networkCommandDescription = 'Show recent HTTP traffic.';
const audioCommandDescription = 'Probe audio levels.';

export const logsCommandMetadata = defineFieldCommandMetadata(
  LOGS_COMMAND_NAME,
  logsCommandDescription,
  {
    action: enumField(LOG_ACTION_VALUES),
    message: stringField(),
    restart: booleanField(),
  },
);

export const eventsCommandMetadata = defineFieldCommandMetadata(
  EVENTS_COMMAND_NAME,
  eventsCommandDescription,
  {
    limit: integerField(),
    cursor: stringField(),
  },
);

export const networkCommandMetadata = defineFieldCommandMetadata(
  NETWORK_COMMAND_NAME,
  networkCommandDescription,
  {
    action: enumField(NETWORK_ACTION_VALUES),
    limit: integerField(),
    include: enumField(NETWORK_INCLUDE_MODES),
  },
);

export const audioCommandMetadata = defineFieldCommandMetadata(
  AUDIO_COMMAND_NAME,
  audioCommandDescription,
  {
    action: enumField(AUDIO_ACTION_VALUES),
    probeAction: enumField(AUDIO_PROBE_ACTION_VALUES),
    durationMs: integerField('Probe duration in milliseconds.'),
    bucketMs: integerField('Audio level bucket size in milliseconds.'),
  },
);

export const logsCommandDefinition = defineExecutableCommand(logsCommandMetadata, (client, input) =>
  client.observability.logs(input),
);

export const eventsCommandDefinition = defineExecutableCommand(
  eventsCommandMetadata,
  (client, input) => client.observability.events(input),
);

export const networkCommandDefinition = defineExecutableCommand(
  networkCommandMetadata,
  (client, input) => client.observability.network(input),
);

export const audioCommandDefinition = defineExecutableCommand(
  audioCommandMetadata,
  (client, input) => client.observability.audio(input),
);

const logsCliSchema = {
  usageOverride:
    'logs path | logs start | logs stop | logs clear [--restart] | logs doctor | logs mark [message...]',
  helpDescription: 'Session app log info, start/stop streaming, diagnostics, and markers',
  summary: 'Manage session app logs',
  positionalArgs: ['path|start|stop|clear|doctor|mark', 'message?'],
  allowsExtraPositionals: true,
  allowedFlags: ['restart'],
} as const satisfies CommandSchemaOverride;

const eventsCliSchema = {
  usageOverride: 'events [limit] [cursor]',
  listUsageOverride: 'events',
  helpDescription: 'Read the daemon-owned session event timeline as paged JSON-friendly entries',
  summary: 'Read session event timeline',
  positionalArgs: ['limit?', 'cursor?'],
} as const satisfies CommandSchemaOverride;

const networkCliSchema = {
  usageOverride:
    'network dump [limit] [summary|headers|body|all] [--include summary|headers|body|all] | network log [limit] [summary|headers|body|all] [--include summary|headers|body|all]',
  listUsageOverride: 'network',
  helpDescription: 'Dump recent HTTP(s) traffic parsed from the session app log',
  summary:
    'Inspect HTTP(S) traffic parsed from session app logs, including summaries, headers, and bodies',
  positionalArgs: ['dump|log', 'limit?', 'include?'],
  allowedFlags: ['networkInclude'],
} as const satisfies CommandSchemaOverride;

const audioCliSchema = {
  usageOverride:
    'audio probe start [durationSeconds] [bucketMs] | audio probe status | audio probe stop',
  listUsageOverride: 'audio',
  helpDescription:
    'Probe browser or host-rendered simulator/emulator audio as compact dBFS buckets',
  summary: 'Probe audio levels',
  positionalArgs: ['probe', 'start|status|stop', 'durationSeconds?', 'bucketMs?'],
} as const satisfies CommandSchemaOverride;

export const logsCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readLogsAction(positionals[0]),
  message: positionals.slice(1).join(' ') || undefined,
  restart: flags.restart,
});

export const eventsCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  limit: positionals[0]?.trim() ? optionalCliNumber(positionals[0]) : undefined,
  cursor: positionals[1],
});

export const networkCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readNetworkAction(positionals[0]),
  limit: optionalCliNumber(positionals[1]),
  include: flags.networkInclude ?? readNetworkInclude(positionals[2]),
});

export const audioCliReader: CliReader = (positionals, flags) => ({
  ...commonInputFromFlags(flags),
  action: readAudioAction(positionals[0]),
  probeAction: readAudioProbeAction(positionals[1]),
  durationMs: readAudioDurationMs(positionals[2]),
  bucketMs: optionalCliNumber(positionals[3]),
});

export const logsDaemonWriter: DaemonWriter = direct(LOGS_COMMAND_NAME, (input) =>
  logsPositionals(input as LogsOptions),
);

export const eventsDaemonWriter: DaemonWriter = (input) =>
  request(EVENTS_COMMAND_NAME, eventsPositionals(input as EventsOptions), input);

export const networkDaemonWriter: DaemonWriter = (input) =>
  request(NETWORK_COMMAND_NAME, networkPositionals(input as NetworkOptions), {
    ...input,
    networkInclude: input.include,
  });

export const audioDaemonWriter: DaemonWriter = (input) =>
  request(AUDIO_COMMAND_NAME, audioPositionals(input as AudioOptions), input);

const logsCommandFacet = defineCommandFacet({
  name: LOGS_COMMAND_NAME,
  metadata: logsCommandMetadata,
  definition: logsCommandDefinition,
  cliSchema: logsCliSchema,
  cliReader: logsCliReader,
  daemonWriter: logsDaemonWriter,
  cliOutputFormatter: observabilityCliOutputFormatters.logs,
});

const eventsCommandFacet = defineCommandFacet({
  name: EVENTS_COMMAND_NAME,
  metadata: eventsCommandMetadata,
  definition: eventsCommandDefinition,
  cliSchema: eventsCliSchema,
  cliReader: eventsCliReader,
  daemonWriter: eventsDaemonWriter,
  cliOutputFormatter: observabilityCliOutputFormatters.events,
});

const networkCommandFacet = defineCommandFacet({
  name: NETWORK_COMMAND_NAME,
  metadata: networkCommandMetadata,
  definition: networkCommandDefinition,
  cliSchema: networkCliSchema,
  cliReader: networkCliReader,
  daemonWriter: networkDaemonWriter,
  cliOutputFormatter: observabilityCliOutputFormatters.network,
});

const audioCommandFacet = defineCommandFacet({
  name: AUDIO_COMMAND_NAME,
  metadata: audioCommandMetadata,
  definition: audioCommandDefinition,
  cliSchema: audioCliSchema,
  cliReader: audioCliReader,
  daemonWriter: audioDaemonWriter,
  cliOutputFormatter: observabilityCliOutputFormatters.audio,
});

export const observabilityCommandFamily = defineCommandFamilyFromFacets({
  name: 'observability',
  commands: [logsCommandFacet, eventsCommandFacet, networkCommandFacet, audioCommandFacet],
});

function logsPositionals(input: { action?: string; message?: string }): string[] {
  return [input.action ?? 'path', ...optionalString(input.message)];
}

function eventsPositionals(input: EventsOptions): string[] {
  if (input.cursor === undefined) return optionalNumber(input.limit);
  return [input.limit === undefined ? '' : String(input.limit), input.cursor];
}

function networkPositionals(input: NetworkOptions): string[] {
  return [...(input.action ? [input.action] : []), ...optionalNumber(input.limit)];
}

function audioPositionals(input: AudioOptions): string[] {
  return [
    input.action ?? 'probe',
    input.probeAction ?? 'status',
    ...optionalNumber(input.durationMs),
    ...optionalNumber(input.bucketMs),
  ];
}

function readLogsAction(value: string | undefined): LogAction | undefined {
  if (value === undefined) return undefined;
  return parseStringMember(LOG_ACTION_VALUES, value, {
    message: 'logs requires path, start, stop, doctor, mark, or clear',
  });
}

function readNetworkAction(value: string | undefined): 'dump' | 'log' | undefined {
  if (value === undefined) return undefined;
  if (value === 'dump' || value === 'log') return value;
  throw new AppError('INVALID_ARGS', 'network requires dump or log');
}

function readNetworkInclude(value: string | undefined): NetworkIncludeMode | undefined {
  if (value === undefined) return undefined;
  return parseStringMember(NETWORK_INCLUDE_MODES, value, {
    message: 'network include must be summary, headers, body, or all',
  });
}

function readAudioAction(value: string | undefined): 'probe' | undefined {
  if (value === undefined) return undefined;
  return parseStringMember(AUDIO_ACTION_VALUES, value, {
    message: 'audio requires probe',
  });
}

function readAudioProbeAction(value: string | undefined): 'start' | 'status' | 'stop' | undefined {
  if (value === undefined) return undefined;
  return parseStringMember(AUDIO_PROBE_ACTION_VALUES, value, {
    message: 'audio probe requires start, status, or stop',
  });
}

function readAudioDurationMs(value: string | undefined): number | undefined {
  const durationSeconds = optionalCliNumber(value);
  return durationSeconds === undefined ? undefined : Math.round(durationSeconds * 1000);
}
