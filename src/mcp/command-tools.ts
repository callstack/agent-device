import type { AgentDeviceClient, AgentDeviceClientConfig } from '../client-types.ts';
import type { JsonSchema } from '../commands/command-contract.ts';
import { RESPONSE_LEVELS, type ResponseLevel } from '../kernel/contracts.ts';
import { formatCliOutput } from '../commands/cli-output.ts';
import {
  isCommandName,
  listMcpCommandMetadata,
  type CommandName,
} from '../commands/command-metadata.ts';
import { COMMAND_OUTPUT_SCHEMAS } from './command-output-schemas.ts';

export type ToolResult = {
  isError: boolean;
  structuredContent?: unknown;
  content: Array<{ type: 'text'; text: string }>;
};

type CommandToolExecutorDeps = {
  createClient?: (
    config: AgentDeviceClientConfig,
  ) => AgentDeviceClient | Promise<AgentDeviceClient>;
  runCommand?: (client: AgentDeviceClient, name: CommandName, input: unknown) => Promise<unknown>;
};

type CommandToolExecutor = {
  execute: (name: string, input: unknown) => Promise<ToolResult>;
};

type McpOutputFormat = 'optimized' | 'json';

type McpToolConfig = {
  client: AgentDeviceClientConfig;
  outputFormat: McpOutputFormat;
};

export function listCommandTools(): Array<{
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}> {
  return listMcpCommandMetadata().map((definition) => {
    // The registry is keyed by the typed-result commands only (CommandResultMap),
    // so guard the lookup; untyped tools resolve to no outputSchema.
    const outputSchema =
      definition.name in COMMAND_OUTPUT_SCHEMAS
        ? COMMAND_OUTPUT_SCHEMAS[definition.name as keyof typeof COMMAND_OUTPUT_SCHEMAS]
        : undefined;
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: withMcpConfigSchema(definition.inputSchema),
      // Only typed commands carry an outputSchema; untyped tools stay
      // byte-identical to today (no key at all), additive-only.
      ...(outputSchema ? { outputSchema } : {}),
    };
  });
}

export function createCommandToolExecutor(deps: CommandToolExecutorDeps = {}): CommandToolExecutor {
  return {
    execute: async (name, input) => {
      if (!isCommandName(name)) {
        throw new Error(`Unknown command tool: ${name}`);
      }
      const config = readMcpToolConfig(input);
      const commandInput = stripMcpConfigFields(input);
      const client = await createClient(deps, config.client);
      const result = await (deps.runCommand ?? runCommand)(client, name, commandInput);
      return {
        isError: false,
        structuredContent: result,
        content: [
          {
            type: 'text',
            text: renderToolText({
              name,
              input: commandInput,
              result,
              outputFormat: config.outputFormat,
              responseLevel: config.client.responseLevel,
            }),
          },
        ],
      };
    },
  };
}

export const commandToolExecutor = createCommandToolExecutor();

async function createClient(
  deps: CommandToolExecutorDeps,
  config: AgentDeviceClientConfig,
): Promise<AgentDeviceClient> {
  if (deps.createClient) return await deps.createClient(config);
  const { createAgentDeviceClient } = await import('../client.ts');
  return createAgentDeviceClient(config);
}

async function runCommand(
  client: AgentDeviceClient,
  name: CommandName,
  input: unknown,
): Promise<unknown> {
  const commandSurface = await import('../commands/command-surface.ts');
  return await commandSurface.runCommand(client, name, input);
}

function readMcpToolConfig(input: unknown): McpToolConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { client: {}, outputFormat: 'optimized' };
  }
  const record = input as Record<string, unknown>;
  return {
    client: readClientConfig(record),
    outputFormat: readMcpOutputFormat(record.mcpOutputFormat),
  };
}

function readClientConfig(record: Record<string, unknown>): AgentDeviceClientConfig {
  const stateDir = record.stateDir;
  const includeCost = record.includeCost;
  const responseLevel = record.responseLevel;
  const client: AgentDeviceClientConfig = {};
  if (stateDir !== undefined && (typeof stateDir !== 'string' || stateDir.length === 0)) {
    throw new Error('Expected stateDir to be a non-empty string.');
  }
  if (typeof stateDir === 'string') client.stateDir = stateDir;
  if (includeCost !== undefined && typeof includeCost !== 'boolean') {
    throw new Error('Expected includeCost to be a boolean.');
  }
  // Only set when explicitly true so the default request shape is untouched
  // (cost rides on response.data → structuredContent only when opted in).
  if (includeCost === true) client.cost = true;
  // Only set when it names a known level so the default request shape is
  // untouched (responseLevel rides on meta.responseLevel only when opted in).
  const level = readResponseLevel(responseLevel);
  if (level !== undefined) client.responseLevel = level;
  return client;
}

function readResponseLevel(value: unknown): ResponseLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !(RESPONSE_LEVELS as readonly string[]).includes(value)) {
    throw new Error("Expected responseLevel to be one of 'digest', 'default', or 'full'.");
  }
  return value as ResponseLevel;
}

function readMcpOutputFormat(outputFormat: unknown): McpOutputFormat {
  if (outputFormat === undefined) return 'optimized';
  if (outputFormat !== 'optimized' && outputFormat !== 'json') {
    throw new Error('Expected mcpOutputFormat to be "optimized" or "json".');
  }
  return outputFormat;
}

function stripMcpConfigFields(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const {
    stateDir: _stateDir,
    mcpOutputFormat: _mcpOutputFormat,
    includeCost: _includeCost,
    responseLevel: _responseLevel,
    ...commandInput
  } = input as Record<string, unknown>;
  return commandInput;
}

function withMcpConfigSchema(schema: JsonSchema): JsonSchema {
  return {
    ...schema,
    properties: {
      ...schema.properties,
      stateDir: { type: 'string', description: 'Agent-device state directory.' },
      mcpOutputFormat: {
        type: 'string',
        enum: ['optimized', 'json'],
        description:
          'MCP text content format. Defaults to optimized agent-friendly text; use json for JSON text. Structured content is always returned separately.',
      },
      includeCost: {
        type: 'boolean',
        description:
          'Include per-command agent-cost (cost.wallClockMs, …) in structuredContent. Defaults to off; the default response shape is unchanged.',
      },
      responseLevel: {
        type: 'string',
        enum: ['digest', 'default', 'full'],
        description:
          'Response verbosity: token-cheap digest / default (today) / full. Defaults to default; the default response shape is unchanged.',
      },
    },
  };
}

function renderToolText(params: {
  name: CommandName;
  input: unknown;
  result: unknown;
  outputFormat: McpOutputFormat;
  responseLevel?: ResponseLevel;
}): string {
  // A non-default responseLevel (digest/full) hands back a leveled payload whose
  // shape the optimized CLI formatters do not understand (e.g. the snapshot
  // formatter expects `nodes`, which the digest drops) — rendering it through
  // them would print misleading text that contradicts `structuredContent`. Emit
  // the leveled payload verbatim as JSON instead.
  if (
    params.outputFormat === 'json' ||
    (params.responseLevel !== undefined && params.responseLevel !== 'default')
  ) {
    return renderJsonText(params.result);
  }
  const cliOutput = formatCliOutput({
    name: params.name,
    input: params.input,
    result: params.result,
  });
  if (typeof cliOutput?.text === 'string') return cliOutput.text;
  return renderJsonText(cliOutput?.data ?? params.result);
}

function renderJsonText(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}
