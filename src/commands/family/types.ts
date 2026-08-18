import type { AgentDeviceClient } from '../../client/client-types.ts';
import type { CommandSchema, CommandSchemaOverride } from '../../cli-schema/types.ts';
import type { AnyDaemonWriter, CliReader } from '../cli-grammar/types.ts';
import type {
  CommandMetadata,
  ExecutableCommandProjection,
  JsonSchema,
} from '../command-contract.ts';
import type { CliOutputFormatter } from '../output-common.ts';
import { resolveFacetText, type FacetCommandText } from '../command-text.ts';

export type AnyCommandMetadata<Name extends string = string> = CommandMetadata<Name, unknown>;

export type AnyCommandDefinition<Name extends string = string> = {
  name: Name;
  description: string;
  mcpDetail?: string;
  inputSchema: JsonSchema;
  invoke: (client: AgentDeviceClient, input: unknown) => Promise<unknown>;
  projection?: ExecutableCommandProjection;
};

export type CommandFamilyFacet<TCommandName extends string = string> = {
  name: string;
  clientSurface?: boolean;
  metadata: readonly AnyCommandMetadata<TCommandName>[];
  definitions: readonly AnyCommandDefinition<TCommandName>[];
  clientCommandMethods?: Readonly<Record<string, TCommandName>>;
  cliSchemas?: Readonly<Partial<Record<TCommandName, CommandSchema>>>;
  cliReaders: Readonly<Record<TCommandName, CliReader>>;
  daemonWriters?: Readonly<Record<string, AnyDaemonWriter>>;
  cliOutputFormatters?: Readonly<Partial<Record<TCommandName, CliOutputFormatter>>>;
};

/**
 * What a command file authors. `cliSchema` carries grammar only and may be omitted entirely;
 * `text` is required, because a command with no list line has nowhere to appear in `--help`.
 */
export type CommandFacetInput<TCommandName extends string = string> = {
  name: TCommandName;
  metadata: AnyCommandMetadata<TCommandName>;
  definition: AnyCommandDefinition<TCommandName>;
  cliSchema?: CommandSchemaOverride;
  clientMethod?: string;
  cliReader: CliReader;
  daemonWriter?: AnyDaemonWriter;
  cliOutputFormatter?: CliOutputFormatter;
  text: FacetCommandText;
};

/**
 * What `defineCommandFacet` returns: the same facet with its schema completed. Stating this as a
 * distinct type is what lets the registry read `cliSchema` without asserting it is populated.
 */
export type CommandFacet<TCommandName extends string = string> = CommandFacetInput<TCommandName> & {
  cliSchema: CommandSchema;
};

type CommandFacetMetadata<TCommands extends readonly CommandFacet[]> = {
  readonly [K in keyof TCommands]: TCommands[K]['metadata'];
};

type CommandFacetDefinitions<TCommands extends readonly CommandFacet[]> = {
  readonly [K in keyof TCommands]: TCommands[K]['definition'];
};

type CommandFacetName<TCommands extends readonly CommandFacet[]> = TCommands[number]['name'];

export type ProjectedCommandOutputSchemas<TDefinitions extends readonly AnyCommandDefinition[]> = {
  [TDefinition in Extract<
    TDefinitions[number],
    { projection: ExecutableCommandProjection }
  > as TDefinition['name']]: JsonSchema;
};

export function defineCommandFacet<
  const TCommandName extends string,
  const TCommand extends CommandFacetInput<TCommandName>,
>(command: TCommand): TCommand & { cliSchema: CommandSchema } {
  // The metadata already holds the canonical description, so the facet never repeats it; the
  // resolved text is what every surface renders from.
  const text = resolveFacetText(command.text, command.metadata.description);
  const mcpTail = text.mcpDetail ? { mcpDetail: text.mcpDetail } : {};
  return {
    ...command,
    metadata: { ...command.metadata, ...mcpTail },
    definition: { ...command.definition, ...mcpTail },
    cliSchema: { ...command.cliSchema, text },
  };
}

export function defineCommandFamilyFromFacets<
  const TFamilyName extends string,
  const TCommands extends readonly CommandFacet[],
>(family: { name: TFamilyName; clientSurface?: boolean; commands: TCommands }) {
  const cliSchemas: Record<string, CommandSchema> = {};
  const clientCommandMethods: Record<string, string> = {};
  const cliReaders: Record<string, CliReader> = {};
  const daemonWriters: Record<string, AnyDaemonWriter> = {};
  const cliOutputFormatters: Record<string, CliOutputFormatter> = {};

  for (const command of family.commands) {
    addRecordEntry(cliSchemas, 'CLI schema', command.name, command.cliSchema);
    const clientMethod = command.definition.projection?.clientMethod ?? command.clientMethod;
    if (clientMethod) {
      addRecordEntry(clientCommandMethods, 'client command method', clientMethod, command.name);
    }
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
    clientCommandMethods: clientCommandMethods as Record<string, CommandFacetName<TCommands>>,
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

export function projectCommandOutputSchemas<
  const TDefinitions extends readonly AnyCommandDefinition[],
>(definitions: TDefinitions): ProjectedCommandOutputSchemas<TDefinitions> {
  const schemas: Record<string, JsonSchema> = {};
  for (const definition of definitions) {
    if (definition.projection) {
      addRecordEntry(
        schemas,
        'command output schema',
        definition.name,
        definition.projection.outputSchema,
      );
    }
  }
  return schemas as ProjectedCommandOutputSchemas<TDefinitions>;
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
