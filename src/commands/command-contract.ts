import type { AgentDeviceClient } from '../client/client-types.ts';
import type { InputAudienceMap } from './input-audience.ts';

export type JsonSchema = {
  type?: string | readonly string[];
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: readonly string[];
  additionalProperties?: boolean | JsonSchema;
  items?: JsonSchema;
  prefixItems?: readonly JsonSchema[];
  oneOf?: readonly JsonSchema[];
  not?: JsonSchema;
  enum?: readonly unknown[];
  const?: unknown;
  minimum?: number;
  maximum?: number;
  /**
   * Marks this object as ANOTHER command's input, naming the sibling property
   * that holds that command's name. Model-facing admission recurses into it
   * with that command's own advertised schema (`mcp/command-tools.ts`).
   */
  commandInputFor?: string;
};

export type CommandMetadata<Name extends string, Input> = {
  name: Name;
  description: string;
  /**
   * MCP-only tail appended to `description` for the MCP tool surface. Stored as the tail alone
   * so `description` remains the single home of the canonical body for CLI help, `explain`,
   * the executable definition, and docs. Compose with `composeMcpDescription`.
   */
  mcpDetail?: string;
  inputSchema: JsonSchema;
  readInput: (input: unknown) => Input;
  /**
   * Non-model audiences this command's own input keys declare
   * (`commands/input-audience.ts`). `retired` keys are excluded from
   * `inputSchema` but still recognized, so the MCP admission boundary lets one
   * through to `readInput`'s migration guidance instead of rejecting it as
   * unknown; `operator` keys stay in `inputSchema` for the CLI and the Node
   * client, and the MCP boundary hides and refuses them.
   *
   * Required, and empty for most commands: a field that declares an audience is
   * only honored because its command carries it here, so leaving this optional
   * would make "forgot to wire it up" a silent model-writable credential rather
   * than a type error. `defineFieldCommandMetadata` derives it from the field
   * map, which is why that is the one construction path for a field command.
   */
  inputAudience: InputAudienceMap;
};

export type ExecutableCommandContract<Name extends string, Input, Result> = CommandMetadata<
  Name,
  Input
> & {
  run: (client: AgentDeviceClient, input: Input) => Promise<Result>;
  invoke: (client: AgentDeviceClient, input: unknown) => Promise<Result>;
};

export type ExecutableCommandProjection<ClientMethod extends string = string> = {
  clientMethod: ClientMethod;
  outputSchema: JsonSchema;
};

export type CliOutput = {
  data: unknown;
  jsonData?: unknown;
  text?: string | null;
  stderr?: string | null;
};

export function defineCommandMetadata<Name extends string, Input>(
  definition: CommandMetadata<Name, Input>,
): CommandMetadata<Name, Input> {
  return definition;
}

export function defineExecutableCommand<Name extends string, Input, Result>(
  metadata: CommandMetadata<Name, Input>,
  run: (client: AgentDeviceClient, input: Input) => Promise<Result>,
): ExecutableCommandContract<Name, Input, Result>;

export function defineExecutableCommand<
  Name extends string,
  Input,
  Result,
  const ClientMethod extends string,
>(
  metadata: CommandMetadata<Name, Input>,
  run: (client: AgentDeviceClient, input: Input) => Promise<Result>,
  projection: ExecutableCommandProjection<ClientMethod>,
): ExecutableCommandContract<Name, Input, Result> & {
  projection: ExecutableCommandProjection<ClientMethod>;
};

export function defineExecutableCommand<Name extends string, Input, Result>(
  metadata: CommandMetadata<Name, Input>,
  run: (client: AgentDeviceClient, input: Input) => Promise<Result>,
  projection?: ExecutableCommandProjection,
): ExecutableCommandContract<Name, Input, Result> & {
  projection?: ExecutableCommandProjection;
} {
  return {
    ...metadata,
    run,
    invoke: async (client, input) => await run(client, metadata.readInput(input)),
    ...(projection ? { projection } : {}),
  };
}
