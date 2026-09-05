import type { AgentDeviceClient } from '../../client/client-types.ts';
import type { CommandSchema, CommandSchemaOverride } from '../../cli-schema/types.ts';
import type { AnyDaemonWriter, CliReader } from '../cli-grammar/types.ts';
import type { CommandMetadata, JsonSchema } from '../command-contract.ts';
import type { CliOutputFormatter } from '../output-common.ts';
import { resolveFacetText, type FacetCommandText } from '../command-text.ts';

export type AnyCommandMetadata<Name extends string = string> = CommandMetadata<Name, unknown>;

export type CommandDefinition<Name extends string = string, Result = unknown> = {
  name: Name;
  description: string;
  mcpDetail?: string;
  inputSchema: JsonSchema;
  invoke: (client: AgentDeviceClient, input: unknown) => Promise<Result>;
};

export type AnyCommandDefinition<Name extends string = string> = CommandDefinition<Name, unknown>;

export type CommandFamilyFacet<TCommandName extends string = string> = {
  name: string;
  clientSurface?: boolean;
  metadata: readonly AnyCommandMetadata<TCommandName>[];
  definitions: readonly AnyCommandDefinition<TCommandName>[];
  cliSchemas?: Readonly<Partial<Record<TCommandName, CommandSchema>>>;
  cliReaders: Readonly<Record<TCommandName, CliReader>>;
  daemonWriters?: Readonly<Record<string, AnyDaemonWriter>>;
  cliOutputFormatters?: Readonly<Partial<Record<TCommandName, CliOutputFormatter>>>;
};

/** What a command file authors: metadata plus `run`; the facet derives the executable from them. */
export type CommandFacetInput<
  TCommandName extends string = string,
  Input = unknown,
  Result = unknown,
  Formatter extends CliOutputFormatter | undefined = CliOutputFormatter | undefined,
> = {
  name: TCommandName;
  metadata: CommandMetadata<TCommandName, Input>;
  run: (client: AgentDeviceClient, input: Input) => Promise<Result>;
  cliSchema?: CommandSchemaOverride;
  cliReader: CliReader;
  daemonWriter?: AnyDaemonWriter;
  cliOutputFormatter?: Formatter;
  text: FacetCommandText;
};

/** The authored facet with `cliSchema` completed and `definition` derived, typed per command. */
export type CommandFacet<
  TCommandName extends string = string,
  Result = unknown,
  Formatter extends CliOutputFormatter | undefined = CliOutputFormatter | undefined,
> = {
  name: TCommandName;
  metadata: AnyCommandMetadata<TCommandName>;
  definition: CommandDefinition<TCommandName, Result>;
  cliSchema: CommandSchema;
  cliReader: CliReader;
  daemonWriter?: AnyDaemonWriter;
  cliOutputFormatter?: Formatter;
  text: FacetCommandText;
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
  Input,
  Result,
  Formatter extends CliOutputFormatter | undefined = undefined,
>(
  command: CommandFacetInput<TCommandName, Input, Result, Formatter>,
): CommandFacet<TCommandName, Result, Formatter> {
  // The metadata already holds the canonical description, so the facet never repeats it; the
  // resolved text is what every surface renders from.
  const text = resolveFacetText(command.text, command.metadata.description);
  const mcpTail = text.mcpDetail ? { mcpDetail: text.mcpDetail } : {};
  const metadata = { ...command.metadata, ...mcpTail };
  const definition: CommandDefinition<TCommandName, Result> = {
    name: metadata.name,
    description: metadata.description,
    inputSchema: metadata.inputSchema,
    ...mcpTail,
    invoke: async (client, input) => await command.run(client, metadata.readInput(input)),
  };
  return {
    name: command.name,
    metadata,
    definition,
    cliSchema: { ...command.cliSchema, text },
    cliReader: command.cliReader,
    daemonWriter: command.daemonWriter,
    cliOutputFormatter: command.cliOutputFormatter,
    text,
  };
}

export function defineCommandFamilyFromFacets<
  const TFamilyName extends string,
  const TCommands extends readonly CommandFacet[],
>(family: { name: TFamilyName; clientSurface?: boolean; commands: TCommands }) {
  const cliSchemas: Record<string, CommandSchema> = {};
  const cliReaders: Record<string, CliReader> = {};
  const daemonWriters: Record<string, AnyDaemonWriter> = {};
  const cliOutputFormatters: Record<string, CliOutputFormatter> = {};

  for (const command of family.commands) {
    addRecordEntry(cliSchemas, 'CLI schema', command.name, command.cliSchema);
    addRecordEntry(cliReaders, 'CLI reader', command.name, command.cliReader);
    if (command.daemonWriter) {
      addRecordEntry(daemonWriters, 'daemon writer', command.name, command.daemonWriter);
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
    cliSchemas: cliSchemas as Partial<Record<CommandFacetName<TCommands>, CommandSchema>>,
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
