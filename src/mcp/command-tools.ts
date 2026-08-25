import type { AgentDeviceClientConfig } from '@agent-device/contracts/client';
import type { AgentDeviceClient } from '../client/client-types.ts';
import type { JsonSchema } from '../commands/command-contract.ts';
import type { CommandExecutionResult } from '../commands/command-surface.ts';
import { RESPONSE_LEVELS, type ResponseLevel } from '@agent-device/kernel/contracts';
import { formatCliOutput } from '../commands/cli-output.ts';
import {
  findCommandMetadata,
  isCommandName,
  listMcpCommandMetadata,
  type CommandName,
} from '../commands/command-metadata.ts';
import { mcpBody } from '../commands/command-text.ts';
import {
  resolveCommandRecordsSessionAction,
  resolveCommandTimeoutPolicy,
} from '../core/command-descriptor/registry.ts';
import { MCP_COMMAND_OUTPUT_SCHEMAS } from './mcp-output-schemas.ts';
import { AppError } from '@agent-device/kernel/errors';
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

/**
 * Operator-owned inputs are never model-writable: the model both reads
 * untrusted app UI text and picks tool arguments, so a screen that steers it
 * into writing a token, an endpoint, or an infrastructure path must find no
 * parameter to write it into. Credentials and the endpoints they are sent to
 * are the hard security boundary (a model-writable daemonBaseUrl or
 * proxyBaseUrl redirects the env-resolved token to an arbitrary server);
 * state/build paths ride along because they select operator infrastructure,
 * not per-call work. All keys are removed from every advertised tool schema
 * and refused as explicit input with migration guidance (the retired-field
 * posture: refuse, never silently drop). Operator-sourced values still flow —
 * env/config defaults merge in `resolveMcpConfigDefaults`, and the daemon and
 * Metro clients fall back to their env vars on their own.
 */
const OPERATOR_INPUT_GUIDANCE: Readonly<Record<string, string>> = {
  // Credentials.
  daemonAuthToken:
    'daemonAuthToken is not accepted as a tool argument. Set the AGENT_DEVICE_DAEMON_AUTH_TOKEN environment variable (or daemonAuthToken in ~/.agent-device/config.json) for the process serving these tools.',
  bearerToken:
    'bearerToken is not accepted as a tool argument. Set the AGENT_DEVICE_METRO_BEARER_TOKEN or AGENT_DEVICE_DAEMON_AUTH_TOKEN environment variable for the process serving these tools.',
  // Endpoints the resolved credentials are sent to.
  daemonBaseUrl:
    'daemonBaseUrl is not accepted as a tool argument. Set the AGENT_DEVICE_DAEMON_BASE_URL environment variable (or daemonBaseUrl in ~/.agent-device/config.json) for the process serving these tools.',
  proxyBaseUrl:
    'proxyBaseUrl is not accepted as a tool argument. Configure the remote proxy in the remote-config profile or operator config for the process serving these tools.',
  // Operator infrastructure paths.
  stateDir:
    'stateDir is not accepted as a tool argument. Set the AGENT_DEVICE_STATE_DIR environment variable (or stateDir in ~/.agent-device/config.json) for the process serving these tools.',
  cwd: 'cwd is not accepted as a tool argument. Start the process serving these tools in the desired working directory, or pass absolute paths.',
  iosSimulatorDeviceSet:
    'iosSimulatorDeviceSet is not accepted as a tool argument. Set iosSimulatorDeviceSet in ~/.agent-device/config.json for the process serving these tools.',
  iosXctestrunFile:
    'iosXctestrunFile is not accepted as a tool argument. Set the AGENT_DEVICE_IOS_XCTESTRUN_FILE environment variable (or iosXctestrunFile in ~/.agent-device/config.json) for the process serving these tools.',
  iosXctestDerivedDataPath:
    'iosXctestDerivedDataPath is not accepted as a tool argument. Set the AGENT_DEVICE_IOS_XCTEST_DERIVED_DATA_PATH environment variable (or iosXctestDerivedDataPath in ~/.agent-device/config.json) for the process serving these tools.',
  iosXctestEnvDir:
    'iosXctestEnvDir is not accepted as a tool argument. Set the AGENT_DEVICE_IOS_XCTEST_ENV_DIR environment variable (or iosXctestEnvDir in ~/.agent-device/config.json) for the process serving these tools.',
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
    const advertised = omitOperatorProperties(
      withMcpConfigSchema(definition.name, definition.inputSchema),
    );
    return {
      name: definition.name,
      description: withTimeoutNote(definition.name, mcpBody(definition)),
      inputSchema: advertised,
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
      // Admission boundary. The MCP router (and the AI SDK adapter) forward raw
      // tools/call arguments verbatim, so this executor is the one place the
      // advertised schema is enforced. Every tool schema is
      // additionalProperties:false, but nothing checked it — so an unadvertised
      // key rode straight into config resolution. `config`/`remoteConfig` are
      // the dangerous case: `resolveMcpConfigDefaults` reads them as CLI flags
      // and loads that file, whose `daemonBaseUrl`/`daemonAuthToken` then reach
      // the command route — a model-writable redirect to an arbitrary endpoint
      // with the operator's token. Reject every raw key the advertised schema
      // does not list, BEFORE config/env defaults merge (operator env/config
      // values still resolve below — they never arrive as tool input).
      const metadata = findCommandMetadata(name);
      const rejection = findInadmissibleInput(name, metadata, input);
      if (rejection) {
        return buildErrorToolResult(
          new AppError('INVALID_ARGS', rejection),
          refPins,
          undefined,
          input.session,
        );
      }
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
  refPins.mergeErrorDetails(normalized.details, stateDir, session);
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

function omitOperatorProperties(
  schema: JsonSchema & { properties: Record<string, JsonSchema> },
): JsonSchema & { properties: Record<string, JsonSchema> } {
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties).filter(
        ([key]) => !Object.hasOwn(OPERATOR_INPUT_GUIDANCE, key),
      ),
    ),
  };
}

// Config-file-loading keys. Not per-command flags but flags the MCP config
// resolver reads to load an arbitrary file; never model-writable, since that
// file can carry operator credentials and endpoints. Rejected by admission
// like any unadvertised key, with a message that points at the operator path.
const CONFIG_LOADER_GUIDANCE: Readonly<Record<string, string>> = {
  config:
    'config is not accepted as a tool argument. Point the process serving these tools at a config file with the AGENT_DEVICE_CONFIG environment variable.',
  remoteConfig:
    'remoteConfig is not accepted as a tool argument. Configure the remote profile on the process serving these tools, not per tool call.',
};

/**
 * The advertised property set for a tool — exactly what `listCommandTools`
 * exposes. Admission and the tool listing derive from this one function so a
 * key can never be hidden from the model yet admitted from the wire.
 */
type AdmissionMetadata = { inputSchema: JsonSchema; retiredInputKeys?: readonly string[] };

function advertisedInputProperties(
  name: CommandName,
  metadata: AdmissionMetadata,
): Record<string, JsonSchema> {
  return omitOperatorProperties(withMcpConfigSchema(name, metadata.inputSchema)).properties;
}

/** The first raw input key the advertised schema does not list, with guidance, or undefined. */
function findInadmissibleInput(
  name: CommandName,
  metadata: AdmissionMetadata,
  input: Record<string, unknown>,
): string | undefined {
  const advertised = advertisedInputProperties(name, metadata);
  // Retired keys are absent from the advertised schema but still recognized:
  // admit them so the command's own reader answers with migration guidance
  // (e.g. maxSize -> "use --scale") instead of a bare unknown-key rejection.
  const retired = new Set(metadata.retiredInputKeys ?? []);
  for (const key of Object.keys(input)) {
    if (Object.hasOwn(advertised, key) || retired.has(key)) continue;
    return (
      OPERATOR_INPUT_GUIDANCE[key] ??
      CONFIG_LOADER_GUIDANCE[key] ??
      `${key} is not an accepted argument for the ${name} tool.`
    );
  }
  return undefined;
}

/**
 * AS-011 answer: the client request envelope from the descriptor registry
 * (timeout-policy, ADR 0008), declared on the tool description so the surface
 * documents it and cannot drift from the enforced value.
 */
function withTimeoutNote(name: CommandName, description: string): string {
  const policy = resolveCommandTimeoutPolicy(name);
  if (policy.envelopeMs === 'unbounded') {
    return `${description} Streams progress; no fixed client timeout.`;
  }
  const seconds = Math.round(policy.envelopeMs / 1000);
  return policy.budget.source === 'none'
    ? `${description} Times out after ${seconds}s.`
    : `${description} Times out after ${seconds}s; a caller-supplied budget extends it.`;
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
