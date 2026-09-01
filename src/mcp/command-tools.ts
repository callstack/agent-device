import type { AgentDeviceClientConfig } from '@agent-device/contracts/client';
import type { AgentDeviceClient } from '../client/client-types.ts';
import type { CommandMetadata, JsonSchema } from '../commands/command-contract.ts';
import type { CommandExecutionResult } from '../commands/command-surface.ts';
import { RESPONSE_LEVELS, type ResponseLevel } from '@agent-device/kernel/contracts';
import { formatCliOutput } from '../commands/cli-output.ts';
import {
  findCommandMetadata,
  isCommandName,
  listCommandMetadata,
  listMcpCommandMetadata,
  type CommandName,
} from '../commands/command-metadata.ts';
import { mcpBody } from '../commands/command-text.ts';
import { resolveStructuredBatchCommandName } from '../core/batch-policy.ts';
import {
  resolveCommandRecordsSessionAction,
  resolveCommandTimeoutPolicy,
} from '../core/command-descriptor/registry.ts';
import { MCP_COMMAND_OUTPUT_SCHEMAS } from './mcp-output-schemas.ts';
import { COMMON_INPUT_AUDIENCE } from '../commands/common-input-fields.ts';
import {
  operatorAudience,
  operatorInputRefusal,
  type InputAudienceMap,
} from '../commands/input-audience.ts';
import {
  MCP_TOOL_CONFIG_AUDIENCE,
  MCP_TOOL_CONFIG_KEYS,
  mcpToolConfigProperties,
} from './tool-control-fields.ts';
import { AppError } from '@agent-device/kernel/errors';
import { isRecord } from '@agent-device/kernel/record';
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
 * Config-file-loading keys. Not per-command flags but flags the MCP config
 * resolver reads to load an arbitrary file; never model-writable, since that
 * file can carry operator credentials and endpoints. They appear in no tool
 * schema, so admission rejects them like any unadvertised key — with a message
 * that points at the operator path instead of the generic unknown-key text.
 */
const CONFIG_LOADER_AUDIENCE: InputAudienceMap = {
  config: operatorAudience({
    operatorPath:
      'Point the process serving these tools at a config file with the AGENT_DEVICE_CONFIG environment variable.',
  }),
  remoteConfig: operatorAudience({
    operatorPath:
      'Configure the remote profile on the process serving these tools, not per tool call.',
  }),
};

/**
 * Every `operator` key any command declares. The deny side is deliberately
 * global rather than per-command: a screen that steers the model into writing a
 * credential must find no tool that takes it, and must be told the operator path
 * on whichever tool it tried. `retired` audiences stay per-command — a key one
 * command removed is simply unknown to the rest.
 */
const DECLARED_OPERATOR_AUDIENCE: InputAudienceMap = Object.fromEntries(
  listCommandMetadata().flatMap((metadata) =>
    Object.entries(metadata.inputAudience).filter(([, audience]) => audience.kind === 'operator'),
  ),
);

/**
 * Who may write each input key of one tool, merged from every declaration that
 * governs it: this command's own fields, the shared common fields, this
 * surface's own tool-config keys and config loaders, and every command-declared
 * operator key. `listCommandTools` and admission both read this, so a key can
 * never be hidden from the model yet admitted from the wire.
 *
 * The command's own map is spread FIRST so an `operator` classification always
 * outranks it. `retired` keys are admitted (the command's reader answers with
 * migration guidance), so a command that retired a key whose name another
 * declaration owns as `operator` must fail closed on the refusal, not open on
 * the guidance. Every operator key a command declares is already in
 * `DECLARED_OPERATOR_AUDIENCE`, so nothing is lost by letting the globals win.
 */
function toolInputAudience(metadata: AdmissionMetadata): InputAudienceMap {
  return {
    ...metadata.inputAudience,
    ...COMMON_INPUT_AUDIENCE,
    ...MCP_TOOL_CONFIG_AUDIENCE,
    ...CONFIG_LOADER_AUDIENCE,
    ...DECLARED_OPERATOR_AUDIENCE,
  };
}

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
    const advertised = advertisedInputSchema(definition.name, definition);
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
      //
      // "Every tool schema is additionalProperties:false" holds for the keys a
      // schema can NAME. A nested command's input keys depend on a sibling
      // value, so `batch` cannot name them and declares that object free-form;
      // the flat scan below then looked straight past it. The second check
      // recurses there — see `findInadmissibleNestedCommandInput`.
      const metadata = findCommandMetadata(name);
      const rejection =
        findInadmissibleInput(name, metadata, input) ??
        findInadmissibleNestedCommandInput(metadata.inputSchema, input, name);
      if (rejection) {
        return await buildErrorToolResult(
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
          structuredContent: await projectStructuredContent(name, result),
          content: [
            {
              type: 'text',
              // Render from the UNPINNED input: the model typed plain refs and
              // must never see generation suffixes (zero token cost).
              text: await renderToolText({
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
        return await buildErrorToolResult(
          error,
          refPins,
          config.client.stateDir,
          commandInput.session,
        );
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
async function buildErrorToolResult(
  error: unknown,
  refPins: ToolRefPinStore,
  stateDir: string | undefined,
  session: unknown,
): Promise<ToolResult> {
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
  return Object.fromEntries(
    Object.entries(input).filter(([key]) => !MCP_TOOL_CONFIG_KEYS.has(key)),
  );
}

type AdmissionMetadata = Pick<CommandMetadata<string, unknown>, 'inputSchema' | 'inputAudience'>;

/**
 * The advertised schema for a tool — exactly what `listCommandTools` exposes.
 * Admission derives from this same function so a key can never be hidden from
 * the model yet admitted from the wire.
 */
function advertisedInputSchema(
  name: CommandName,
  metadata: AdmissionMetadata,
): JsonSchema & { properties: Record<string, JsonSchema> } {
  const audience = toolInputAudience(metadata);
  const schema = withMcpConfigSchema(name, metadata.inputSchema);
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(schema.properties).filter(([key]) => audience[key]?.kind !== 'operator'),
    ),
  };
}

/** The first raw input key the advertised schema does not list, with guidance, or undefined. */
function findInadmissibleInput(
  name: CommandName,
  metadata: AdmissionMetadata,
  input: Record<string, unknown>,
): string | undefined {
  const advertised = advertisedInputSchema(name, metadata).properties;
  const audience = toolInputAudience(metadata);
  for (const key of Object.keys(input)) {
    if (Object.hasOwn(advertised, key)) continue;
    // `Object.hasOwn`, not a plain lookup: `key` is a raw tool argument name, so
    // `__proto__`/`constructor`/`toString` would otherwise read a value off
    // `Object.prototype` and classify against it.
    const keyAudience = Object.hasOwn(audience, key) ? audience[key] : undefined;
    // Retired keys are absent from the advertised schema but still recognized:
    // admit them so the command's own reader answers with migration guidance
    // (e.g. maxSize -> "use --scale") instead of a bare unknown-key rejection.
    if (keyAudience?.kind === 'retired') continue;
    if (keyAudience?.kind === 'operator') return operatorInputRefusal(key, keyAudience.source);
    return `${key} is not an accepted argument for the ${name} tool.`;
  }
  return undefined;
}

/**
 * The first inadmissible key inside a NESTED command input, with guidance, or
 * undefined.
 *
 * {@link findInadmissibleInput} reads the FLAT keys of a tool call, which is the
 * whole boundary for a tool whose schema is `additionalProperties:false` all the
 * way down. `batch` is not: a step's accepted keys depend on its sibling
 * `command`, which JSON Schema cannot express, so `steps[].input` is declared
 * free-form and the flat scan looked straight past it. Everything the flat scan
 * refuses was therefore admitted one level in — and `readBatchDaemonStep`
 * projects a step's input into per-step daemon request FLAGS, where
 * `iosSimulatorDeviceSet` picks the simulator device set `resolveTargetDevice`
 * searches and `iosXctestrunFile` picks the `.xctestrun` the Apple runner
 * launches. That is the operator-infrastructure write
 * {@link OPERATOR_INPUT_GUIDANCE} exists to refuse, reached through the one
 * input the model is invited to nest.
 *
 * So the schema declares where those objects are (`commandInputFor` names the
 * sibling holding the command name) and this walks the tool's own schema against
 * the raw arguments, checking each one with {@link findInadmissibleInput}
 * against that command's advertised schema. Nested admission is the same
 * function, and returns the same answer, as flat admission: a step's input
 * accepts exactly what the nested command's own tool accepts, no more.
 */
function findInadmissibleNestedCommandInput(
  schema: JsonSchema | undefined,
  value: unknown,
  path: string,
): string | undefined {
  if (!schema || value === undefined) return undefined;
  if (Array.isArray(value)) {
    return firstRejection(value, (item, index) =>
      findInadmissibleNestedCommandInput(schema.items, item, `${path}[${index}]`),
    );
  }
  if (!isRecord(value)) return undefined;
  return (
    firstRejection(schema.oneOf ?? [], (branch) =>
      findInadmissibleNestedCommandInput(branch, value, path),
    ) ??
    firstRejection(Object.entries(schema.properties ?? {}), ([key, property]) =>
      Object.hasOwn(value, key)
        ? findInadmissibleNestedProperty(property, value, key, `${path}.${key}`)
        : undefined,
    )
  );
}

function findInadmissibleNestedProperty(
  property: JsonSchema,
  parent: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const commandKey = property.commandInputFor;
  if (commandKey === undefined) {
    return findInadmissibleNestedCommandInput(property, parent[key], path);
  }
  const nested = parent[key];
  // Resolve exactly as the nested reader does, never by matching the raw value:
  // a step is normalized before it runs, so ` SNAPSHOT ` is no command here and
  // `snapshot` there — admission would check nothing and the daemon would run it
  // with the operator paths still aboard. `resolveStructuredBatchCommandName` is
  // the function the readers themselves call, so the two cannot drift apart.
  const command = resolveStructuredBatchCommandName(parent[commandKey]);
  // A name that resolves to nothing leaves nothing to check against, and nothing
  // to protect: the reader refuses that step, so nothing it carries reaches a
  // daemon request flag. Reporting it is the reader's job — answering here would
  // bury the real error under a key complaint.
  if (command === undefined || !isRecord(nested)) return undefined;
  const rejection = findInadmissibleInput(command, findCommandMetadata(command), nested);
  return rejection === undefined ? undefined : `${path}: ${rejection}`;
}

function firstRejection<TItem>(
  items: readonly TItem[],
  check: (item: TItem, index: number) => string | undefined,
): string | undefined {
  for (const [index, item] of items.entries()) {
    const rejection = check(item, index);
    if (rejection) return rejection;
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
      ...mcpToolConfigProperties(),
    },
  };
}

async function renderToolText(params: {
  name: CommandName;
  input: Record<string, unknown>;
  result: CommandExecutionResult;
  outputFormat: McpOutputFormat;
  responseLevel?: ResponseLevel;
}): Promise<string> {
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
  const cliOutput = await formatCliOutput({
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
