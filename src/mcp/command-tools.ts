import type { AgentDeviceClient, AgentDeviceClientConfig } from '../client/client-types.ts';
import type { JsonSchema } from '../commands/command-contract.ts';
import { RESPONSE_LEVELS, type ResponseLevel } from '../kernel/contracts.ts';
import { formatCliOutput } from '../commands/cli-output.ts';
import {
  isCommandName,
  listMcpCommandMetadata,
  type CommandName,
} from '../commands/command-metadata.ts';
import { COMMAND_OUTPUT_SCHEMAS } from './command-output-schemas.ts';
import { AppError } from '../kernel/errors.ts';

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
  // #1076 versioned refs — MCP auto-pinning state: the last `refsGeneration`
  // observed on a ref-issuing (snapshot/find) response, per session name.
  const sessionRefGenerations = new Map<string, number>();
  return {
    execute: async (name, input) => {
      if (!isCommandName(name)) {
        throw new AppError('INVALID_ARGS', `Unknown command tool: ${name}`);
      }
      const config = readMcpToolConfig(input);
      const commandInput = stripMcpConfigFields(input);
      const sessionKey = readSessionKey(commandInput);
      const pinnedInput = pinPlainRefArguments(
        name,
        commandInput,
        sessionRefGenerations.get(sessionKey),
      );
      const client = await createClient(deps, config.client);
      const result = await (deps.runCommand ?? runCommand)(client, name, pinnedInput);
      trackIssuedRefsGeneration(sessionRefGenerations, sessionKey, name, result);
      return {
        isError: false,
        structuredContent: result,
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
    },
  };
}

/**
 * #1076 versioned refs — MCP auto-pinning. Snapshot trees and find outputs
 * keep plain `e12` refs (snapshots are the most token-expensive artifact the
 * model consumes); the issuing response carries the tree's generation ONCE as
 * `refsGeneration`. This layer sees those responses before the model does:
 * it remembers the last issued generation per session name and rewrites plain
 * `@ref` tool arguments to the pinned `@ref~s<generation>` form before
 * forwarding to the daemon — the daemon can then warn PRECISELY when a ref
 * outlives the tree that minted it. The model never sees or types suffixes.
 */
const REF_ISSUING_TOOLS: ReadonlySet<CommandName> = new Set(['snapshot', 'find'] as CommandName[]);

const TARGET_REF_TOOLS: ReadonlySet<CommandName> = new Set([
  'press',
  'click',
  'fill',
  'longpress',
  'get',
] as CommandName[]);

function readSessionKey(input: unknown): string {
  const record = asOptionalRecord(input);
  const session = record?.session;
  return typeof session === 'string' && session.length > 0 ? session : 'default';
}

function trackIssuedRefsGeneration(
  generations: Map<string, number>,
  sessionKey: string,
  name: CommandName,
  result: unknown,
): void {
  if (!REF_ISSUING_TOOLS.has(name)) return;
  const refsGeneration = asOptionalRecord(result)?.refsGeneration;
  if (typeof refsGeneration === 'number') {
    generations.set(sessionKey, refsGeneration);
    return;
  }
  // The ref-issuing response carried no generation (older daemon, or a find
  // that returned no ref). Forget the remembered one rather than pin future
  // refs to a value the response did not vouch for — never guess.
  generations.delete(sessionKey);
}

function pinPlainRefArguments(
  name: CommandName,
  input: unknown,
  generation: number | undefined,
): unknown {
  // No remembered generation for this session → pass refs through unpinned.
  if (generation === undefined) return input;
  const record = asOptionalRecord(input);
  if (!record) return input;
  if (name === 'wait') return pinWaitRef(record, generation) ?? input;
  if (TARGET_REF_TOOLS.has(name)) return pinTargetRef(record, generation) ?? input;
  return input;
}

function pinWaitRef(
  record: Record<string, unknown>,
  generation: number,
): Record<string, unknown> | undefined {
  if (typeof record.ref !== 'string') return undefined;
  const pinned = pinRef(record.ref, generation);
  return pinned === record.ref ? undefined : { ...record, ref: pinned };
}

function pinTargetRef(
  record: Record<string, unknown>,
  generation: number,
): Record<string, unknown> | undefined {
  const target = asOptionalRecord(record.target);
  if (target?.kind !== 'ref' || typeof target.ref !== 'string') return undefined;
  const pinned = pinRef(target.ref, generation);
  return pinned === target.ref ? undefined : { ...record, target: { ...target, ref: pinned } };
}

function pinRef(ref: string, generation: number): string {
  // Only pin the canonical plain form `@e12`: an existing `~` means the ref is
  // already pinned (or malformed — the daemon owns rejecting that), and a
  // missing `@` prefix is not a ref the daemon would accept anyway.
  if (!ref.startsWith('@') || ref.includes('~')) return ref;
  return `${ref}~s${generation}`;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

export const commandToolExecutor = createCommandToolExecutor();

async function createClient(
  deps: CommandToolExecutorDeps,
  config: AgentDeviceClientConfig,
): Promise<AgentDeviceClient> {
  if (deps.createClient) return await deps.createClient(config);
  const { createAgentDeviceClient } = await import('../client/client.ts');
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
    throw new AppError('INVALID_ARGS', 'Expected stateDir to be a non-empty string.');
  }
  if (typeof stateDir === 'string') client.stateDir = stateDir;
  if (includeCost !== undefined && typeof includeCost !== 'boolean') {
    throw new AppError('INVALID_ARGS', 'Expected includeCost to be a boolean.');
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
    throw new AppError(
      'INVALID_ARGS',
      "Expected responseLevel to be one of 'digest', 'default', or 'full'.",
    );
  }
  return value as ResponseLevel;
}

function readMcpOutputFormat(outputFormat: unknown): McpOutputFormat {
  if (outputFormat === undefined) return 'optimized';
  if (outputFormat !== 'optimized' && outputFormat !== 'json') {
    throw new AppError('INVALID_ARGS', 'Expected mcpOutputFormat to be "optimized" or "json".');
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
