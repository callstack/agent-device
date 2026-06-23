import type { AgentDeviceClient } from '../../client-types.ts';
import type { CommandSchemaOverride } from '../../utils/cli-command-schema-types.ts';
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
  cliReader: CliReader;
  daemonWriter?: DaemonWriter;
  cliOutputFormatter?: CliOutputFormatter;
};

type CommandFacetMetadata<TCommands extends readonly CommandFacet[]> = {
  readonly [K in keyof TCommands]: TCommands[K]['metadata'];
};

type CommandFacetDefinitions<TCommands extends readonly CommandFacet[]> = {
  readonly [K in keyof TCommands]: TCommands[K]['definition'];
};

type CommandFacetName<TCommands extends readonly CommandFacet[]> = TCommands[number]['name'];

type CommandFamilyMetadataName<TMetadata extends readonly AnyCommandMetadata[]> =
  TMetadata[number]['name'];

export function defineCommandFamily<
  const TMetadata extends readonly AnyCommandMetadata[],
  const TDefinitions extends readonly AnyCommandDefinition<CommandFamilyMetadataName<TMetadata>>[],
  const TFamily extends CommandFamilyFacet<CommandFamilyMetadataName<TMetadata>> & {
    metadata: TMetadata;
    definitions: TDefinitions;
  },
>(family: TFamily): TFamily {
  return family;
}

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
  const cliReaders: Record<string, CliReader> = {};
  const daemonWriters: Record<string, DaemonWriter> = {};
  const cliOutputFormatters: Record<string, CliOutputFormatter> = {};

  for (const command of family.commands) {
    if (command.cliSchema) cliSchemas[command.name] = command.cliSchema;
    cliReaders[command.name] = command.cliReader;
    if (command.daemonWriter) daemonWriters[command.name] = command.daemonWriter;
    if (command.cliOutputFormatter) {
      cliOutputFormatters[command.name] = command.cliOutputFormatter;
    }
  }

  return defineCommandFamily({
    name: family.name,
    clientSurface: family.clientSurface,
    metadata: family.commands.map((command) => command.metadata) as CommandFacetMetadata<TCommands>,
    definitions: family.commands.map(
      (command) => command.definition,
    ) as CommandFacetDefinitions<TCommands>,
    cliSchemas,
    cliReaders: cliReaders as Record<CommandFacetName<TCommands>, CliReader>,
    daemonWriters,
    cliOutputFormatters,
  });
}
