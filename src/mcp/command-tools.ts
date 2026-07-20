import type { AgentDeviceClient, AgentDeviceClientConfig } from '../client/client-types.ts';
import type { JsonSchema } from '../commands/command-contract.ts';
import type { CommandExecutionResult } from '../commands/command-surface.ts';
import { RESPONSE_LEVELS, type ResponseLevel } from '../kernel/contracts.ts';
import { formatCliOutput } from '../commands/cli-output.ts';
import {
  findCommandMetadata,
  isCommandName,
  listMcpCommandMetadata,
  type CommandName,
} from '../commands/command-metadata.ts';
import { resolveCommandRecordsSessionAction } from '../core/command-descriptor/registry.ts';
import { MCP_COMMAND_OUTPUT_SCHEMAS } from './mcp-output-schemas.ts';
import { AppError } from '../kernel/errors.ts';
import { formatToolErrorText, normalizeToolError } from './tool-error.ts';
import { resolveMcpConfigDefaults } from './tool-input-config.ts';
import { projectStructuredContent } from './tool-result.ts';
import { createToolRefPinStore, type ToolRefPinStore } from './tool-ref-pins.ts';

export type ToolResult = {
  isError: boolean;
  structuredContent?: Record<string, unknown>;
  content: Array<{ type: 'text'; text: string }>;
};

type CommandToolExecutorDeps = {
  createClient?: (
    config: AgentDeviceClientConfig,
  ) => AgentDeviceClient | Promise<AgentDeviceClient>;
  runCommand?: (
    client: AgentDeviceClient,
    name: CommandName,
    input: Record<string, unknown>,
  ) => Promise<CommandExecutionResult>;
};

type CommandToolExecutor = {
  execute: (name: string, input: Record<string, unknown>) => Promise<ToolResult>;
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
      definition.name in MCP_COMMAND_OUTPUT_SCHEMAS
        ? MCP_COMMAND_OUTPUT_SCHEMAS[definition.name as keyof typeof MCP_COMMAND_OUTPUT_SCHEMAS]
        : undefined;
    return {
      name: definition.name,
      description: definition.description,
      inputSchema: withMcpConfigSchema(definition.name, definition.inputSchema),
      // Only typed commands carry an outputSchema; untyped tools stay
      // byte-identical to today (no key at all), additive-only.
      ...(outputSchema ? { outputSchema } : {}),
    };
  });
}

export function createCommandToolExecutor(deps: CommandToolExecutorDeps = {}): CommandToolExecutor {
  const refPins = createToolRefPinStore();
  return {
    execute: async (name, input) => {
      if (!isCommandName(name)) {
        throw new AppError('INVALID_ARGS', `Unknown command tool: ${name}`);
      }
      const metadata = findCommandMetadata(name);
      const supportedProperties = withMcpConfigSchema(name, metadata.inputSchema).properties;
      const resolvedInput = resolveMcpConfigDefaults(name, input, supportedProperties);
      const config = readMcpToolConfig(resolvedInput);
      const commandInput = stripMcpConfigFields(resolvedInput);
      const pinnedInput = refPins.pinInput(name, commandInput, config.client.stateDir);
      const client = await createClient(deps, config.client);
      try {
        const result = await (deps.runCommand ?? runCommand)(client, name, pinnedInput);
        refPins.mergeCommandResult(name, result, config.client.stateDir, commandInput.session);
        return {
          isError: false,
          structuredContent: projectStructuredContent(name, result),
          content: [
            {
              type: 'text',
              // Render from the UNPINNED input: the model typed plain refs and
              // must never see generation suffixes (zero token cost).
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
      } catch (error) {
        return buildErrorToolResult(error, refPins, config.client.stateDir, commandInput.session);
      }
    },
  };
}

/**
 * ADR 0012: a command error is a ref-issuing result — `isError: true`, the
 * normalized error as `structuredContent`, and an `available`
 * `divergence.screen`'s refs merged/pinned at `refsGeneration` like any
 * ref-issuing success. Merge-only; never clears existing pins.
 */
function buildErrorToolResult(
  error: unknown,
  refPins: ToolRefPinStore,
  stateDir: string | undefined,
  session: unknown,
): ToolResult {
  const normalized = normalizeToolError(error);
  refPins.mergeDivergenceScreen(normalized.details, stateDir, session);
  return {
    isError: true,
    structuredContent: normalized,
    content: [{ type: 'text', text: formatToolErrorText(normalized) }],
  };
}

export const commandToolExecutor = createCommandToolExecutor();

async function createClient(
  deps: CommandToolExecutorDeps,
  config: AgentDeviceClientConfig,
): Promise<AgentDeviceClient> {
  if (deps.createClient) return await deps.createClient(config);
  const { createAgentDeviceClient } = await import('../agent-device-client.ts');
  return createAgentDeviceClient(config);
}

async function runCommand(
  client: AgentDeviceClient,
  name: CommandName,
  input: Record<string, unknown>,
): Promise<CommandExecutionResult> {
  const commandSurface = await import('../commands/command-surface.ts');
  return await commandSurface.runCommand(client, name, input);
}

function readMcpToolConfig(record: Record<string, unknown>): McpToolConfig {
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
  if (stateDir !== undefined) {
    if (typeof stateDir !== 'string' || stateDir.length === 0) {
      throw new AppError('INVALID_ARGS', 'Expected stateDir to be a non-empty string.');
    }
    client.stateDir = stateDir;
  }
  if (includeCost !== undefined) {
    if (typeof includeCost !== 'boolean') {
      throw new AppError('INVALID_ARGS', 'Expected includeCost to be a boolean.');
    }
    // Only set when explicitly true so the default request shape is untouched
    // (cost rides on response.data → structuredContent only when opted in).
    if (includeCost) client.cost = true;
  }
  // Only set when it names a known level so the default request shape is
  // untouched (responseLevel rides on meta.responseLevel only when opted in).
  const level = readResponseLevel(responseLevel);
  if (level !== undefined) client.responseLevel = level;
  return client;
}

function readResponseLevel(value: unknown): ResponseLevel | undefined {
  if (value === undefined) return undefined;
  const level = RESPONSE_LEVELS.find((candidate) => candidate === value);
  if (level === undefined) {
    throw new AppError(
      'INVALID_ARGS',
      "Expected responseLevel to be one of 'digest', 'default', or 'full'.",
    );
  }
  return level;
}

function readMcpOutputFormat(outputFormat: unknown): McpOutputFormat {
  if (outputFormat === undefined) return 'optimized';
  if (outputFormat !== 'optimized' && outputFormat !== 'json') {
    throw new AppError('INVALID_ARGS', 'Expected mcpOutputFormat to be "optimized" or "json".');
  }
  return outputFormat;
}

function stripMcpConfigFields(input: Record<string, unknown>): Record<string, unknown> {
  const {
    stateDir: _stateDir,
    mcpOutputFormat: _mcpOutputFormat,
    includeCost: _includeCost,
    responseLevel: _responseLevel,
    ...commandInput
  } = input;
  return commandInput;
}

function withMcpConfigSchema(
  name: CommandName,
  schema: JsonSchema,
): JsonSchema & { properties: Record<string, JsonSchema> } {
  const noRecord = resolveCommandRecordsSessionAction(name);
  return {
    ...schema,
    properties: {
      ...schema.properties,
      ...(noRecord && !schema.properties?.noRecord
        ? {
            noRecord: {
              type: 'boolean',
              description: 'Do not record this action.',
            },
          }
        : {}),
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
  input: Record<string, unknown>;
  result: CommandExecutionResult;
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
