import type { AgentDeviceClient } from '../../client/client-types.ts';
import type { CommandSchemaOverride } from '../../cli-schema/types.ts';
import type { CliReader, DaemonWriter } from '../cli-grammar/types.ts';
import type { CommandMetadata, JsonSchema } from '../command-contract.ts';
import type { CliOutputFormatter } from '../output-common.ts';

export type AnyCommandMetadata<Name extends string = string> = CommandMetadata<Name, unknown>;

export type AnyCommandDefinition<Name extends string = string> = {
  name: Name;
  description: string;
  inputSchema: JsonSchema;
  invoke: (client: AgentDeviceClient, input: unknown) => Promise<unknown>;
};

export type CommandFamilyFacet<TCommandName extends string = string> = {
  name: string;
  clientSurface?: boolean;
  metadata: readonly AnyCommandMetadata<TCommandName>[];
  definitions: readonly AnyCommandDefinition<TCommandName>[];
  clientCommandMethods?: Readonly<Record<string, TCommandName>>;
  cliSchemas?: Readonly<Partial<Record<TCommandName, CommandSchemaOverride>>>;
  cliReaders: Readonly<Record<TCommandName, CliReader>>;
  daemonWriters?: Readonly<Record<string, DaemonWriter>>;
  cliOutputFormatters?: Readonly<Partial<Record<TCommandName, CliOutputFormatter>>>;
};

export type CommandFacet<TCommandName extends string = string> = {
  name: TCommandName;
  metadata: AnyCommandMetadata<TCommandName>;
  definition: AnyCommandDefinition<TCommandName>;
  cliSchema?: CommandSchemaOverride;
  clientMethod?: string;
  cliReader: CliReader;
  daemonWriter?: DaemonWriter;
  extraDaemonWriters?: Readonly<Record<string, DaemonWriter>>;
  cliOutputFormatter?: CliOutputFormatter;
};

type CommandFacetMetadata<TCommands extends readonly CommandFacet[]> = {
  readonly [K in keyof TCommands]: TCommands[K]['metadata'];
};

type CommandFacetDefinitions<TCommands extends readonly CommandFacet[]> = {
  readonly [K in keyof TCommands]: TCommands[K]['definition'];
};

type CommandFacetName<TCommands extends readonly CommandFacet[]> = TCommands[number]['name'];

export function defineCommandFacet<
  const TCommandName extends string,
  const TCommand extends CommandFacet<TCommandName>,
>(command: TCommand): TCommand {
  return command;
}

export function defineCommandFamilyFromFacets<
  const TFamilyName extends string,
  const TCommands extends readonly CommandFacet[],
>(family: { name: TFamilyName; clientSurface?: boolean; commands: TCommands }) {
  const cliSchemas: Record<string, CommandSchemaOverride> = {};
  const clientCommandMethods: Record<string, string> = {};
  const cliReaders: Record<string, CliReader> = {};
  const daemonWriters: Record<string, DaemonWriter> = {};
  const cliOutputFormatters: Record<string, CliOutputFormatter> = {};

  for (const command of family.commands) {
    if (command.cliSchema) {
      addRecordEntry(cliSchemas, 'CLI schema', command.name, command.cliSchema);
    }
    if (command.clientMethod) {
      addRecordEntry(
        clientCommandMethods,
        'client command method',
        command.clientMethod,
        command.name,
      );
    }
    addRecordEntry(cliReaders, 'CLI reader', command.name, command.cliReader);
    if (command.daemonWriter) {
      addRecordEntry(daemonWriters, 'daemon writer', command.name, command.daemonWriter);
    }
    if (command.extraDaemonWriters) {
      for (const [name, writer] of Object.entries(command.extraDaemonWriters)) {
        addRecordEntry(daemonWriters, 'daemon writer', name, writer);
      }
    }
    if (command.cliOutputFormatter) {
      addRecordEntry(
        cliOutputFormatters,
        'CLI output formatter',
        command.name,
        command.cliOutputFormatter,
      );
    }
  }

  return {
    name: family.name,
    clientSurface: family.clientSurface,
    metadata: family.commands.map((command) => command.metadata) as CommandFacetMetadata<TCommands>,
    definitions: family.commands.map(
      (command) => command.definition,
    ) as CommandFacetDefinitions<TCommands>,
    clientCommandMethods: clientCommandMethods as Record<string, CommandFacetName<TCommands>>,
    cliSchemas: cliSchemas as Partial<Record<CommandFacetName<TCommands>, CommandSchemaOverride>>,
    cliReaders: cliReaders as Record<CommandFacetName<TCommands>, CliReader>,
    daemonWriters,
    cliOutputFormatters: cliOutputFormatters as Partial<
      Record<CommandFacetName<TCommands>, CliOutputFormatter>
    >,
  } satisfies CommandFamilyFacet<CommandFacetName<TCommands>> & {
    metadata: CommandFacetMetadata<TCommands>;
    definitions: CommandFacetDefinitions<TCommands>;
  };
}

function addRecordEntry<TValue>(
  record: Record<string, TValue>,
  label: string,
  name: string,
  value: TValue,
): void {
  if (Object.hasOwn(record, name)) {
    throw new Error(`Duplicate command family ${label}: ${name}`);
  }
  record[name] = value;
}
