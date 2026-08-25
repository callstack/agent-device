import type { AgentDeviceClient } from '../client/client-types.ts';

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
   * Released input keys the command removed. Excluded from `inputSchema` (not
   * advertised), but still recognized: `readInput` throws migration guidance
   * when one is supplied. The MCP admission boundary reads this so it lets a
   * retired key reach that message instead of rejecting it as unknown.
   */
  retiredInputKeys?: readonly string[];
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
