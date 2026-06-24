import { batchCommandFamily } from '../batch/index.ts';
import { captureCommandFamily } from '../capture/index.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import { debuggingCommandFamily } from '../debugging/index.ts';
import { interactionCommandFamily } from '../interaction/index.ts';
import { managementCommandFamily } from '../management/index.ts';
import { metroCommandFamily } from '../metro/index.ts';
import { observabilityCommandFamily } from '../observability/index.ts';
import type { CliOutputFormatter } from '../output-common.ts';
import { perfCommandFamily } from '../perf/index.ts';
import { reactNativeCommandFamily } from '../react-native/index.ts';
import { recordingCommandFamily } from '../recording/index.ts';
import { replayCommandFamily } from '../replay/index.ts';
import { systemCommandFamily } from '../system/index.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
import { type CommandFamilyFacet } from './types.ts';

type CommandFamilyRecordMap = {
  cliSchemas: CommandSchemaOverride;
  cliReaders: CliReader;
  daemonWriters: DaemonWriter;
  cliOutputFormatters: CliOutputFormatter;
};

export const commandFamilies = [
  interactionCommandFamily,
  managementCommandFamily,
  captureCommandFamily,
  systemCommandFamily,
  reactNativeCommandFamily,
  replayCommandFamily,
  observabilityCommandFamily,
  perfCommandFamily,
  debuggingCommandFamily,
  recordingCommandFamily,
  metroCommandFamily,
  batchCommandFamily,
] as const satisfies readonly CommandFamilyFacet[];

export type CommandFamilyCommandName = (typeof commandFamilies)[number]['metadata'][number]['name'];
export type CommandFamilyMetadata = (typeof commandFamilies)[number]['metadata'][number];
export type CommandFamilyDefinition = (typeof commandFamilies)[number]['definitions'][number];

export function listCommandFamilyMetadata(): CommandFamilyMetadata[] {
  return commandFamilies.flatMap((family) => [...family.metadata]);
}

export function listCommandFamilyDefinitions(): CommandFamilyDefinition[] {
  return commandFamilies.flatMap((family) => [...family.definitions]);
}

export function listCommandFamilyCliSchemas(): Record<string, CommandSchemaOverride> {
  return mergeFamilyRecords('cliSchemas');
}

export function listCommandFamilyCliReaders(): Record<CommandFamilyCommandName, CliReader> {
  return mergeFamilyRecords('cliReaders') as Record<CommandFamilyCommandName, CliReader>;
}

export function listCommandFamilyDaemonWriters(): Record<string, DaemonWriter> {
  return mergeFamilyRecords('daemonWriters');
}

export function listCommandFamilyCliOutputFormatters(): Record<string, CliOutputFormatter> {
  return mergeFamilyRecords('cliOutputFormatters');
}

function mergeFamilyRecords<TKey extends keyof CommandFamilyRecordMap>(
  key: TKey,
): Record<string, CommandFamilyRecordMap[TKey]> {
  const records: Record<string, CommandFamilyRecordMap[TKey]> = {};
  for (const family of commandFamilies) {
    const record = family[key] as
      | Readonly<Record<string, CommandFamilyRecordMap[TKey]>>
      | undefined;
    if (!record) continue;
    for (const [command, value] of Object.entries(record)) {
      if (Object.hasOwn(records, command)) {
        throw new Error(`Duplicate ${String(key)} command family entry: ${command}`);
      }
      records[command] = value;
    }
  }
  return records;
}
