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
import { formatToolErrorText, normalizeToolError } from './tool-error.ts';

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
  // #1076 versioned refs — MCP auto-pinning state: per pin scope (state dir +
  // session name), the generation each ref body was LAST ISSUED at.
  const refPinsByScope = new Map<string, Map<string, number>>();
  return {
    execute: async (name, input) => {
      if (!isCommandName(name)) {
        throw new AppError('INVALID_ARGS', `Unknown command tool: ${name}`);
      }
      const config = readMcpToolConfig(input);
      const commandInput = stripMcpConfigFields(input);
      const scopeKey = readPinScopeKey(config, commandInput);
      const pinnedInput = pinPlainRefArguments(name, commandInput, refPinsByScope.get(scopeKey));
      const client = await createClient(deps, config.client);
      try {
        const result = await (deps.runCommand ?? runCommand)(client, name, pinnedInput);
        mergeIssuedRefPins(refPinsByScope, scopeKey, name, result);
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
      } catch (error) {
        return buildErrorToolResult(error, refPinsByScope, scopeKey);
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
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
): ToolResult {
  const normalized = normalizeToolError(error);
  mergeDivergenceScreenRefPins(refPinsByScope, scopeKey, normalized.details);
  return {
    isError: true,
    structuredContent: normalized,
    content: [{ type: 'text', text: formatToolErrorText(normalized) }],
  };
}

function mergeDivergenceScreenRefPins(
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
  details: Record<string, unknown> | undefined,
): void {
  const divergence = asOptionalRecord(details?.divergence);
  const screen = asOptionalRecord(divergence?.screen);
  if (!screen || screen.state !== 'available') return;
  const refsGeneration = screen.refsGeneration;
  if (typeof refsGeneration !== 'number') return;
  const issuedRefs: string[] = [];
  collectRefBodies(screen.refs, issuedRefs);
  mergeIntoScopedPins(refPinsByScope, scopeKey, issuedRefs, refsGeneration);
}

/**
 * #1076 versioned refs — MCP auto-pinning. Snapshot trees and find outputs
 * keep plain `e12` refs (snapshots are the most token-expensive artifact the
 * model consumes); the issuing response carries the tree's generation ONCE as
 * `refsGeneration`. This layer sees those responses before the model does and
 * keeps PER-REF provenance: every ref present in a ref-issuing response is
 * recorded at that response's generation, and refs absent from it KEEP their
 * older pins. That per-ref memory is the point — after snapshot(s12) then
 * find(s13), a plain `@e37` from the pre-find snapshot must still forward as
 * `@e37~s12` so the daemon warns precisely; a single last-seen generation
 * would silently re-bless it at s13 (the exact find-blessing hole #1076
 * describes). Refs never seen in an issuing response pass through unpinned
 * (the coarse #1093 warning is the floor). The model never sees or types
 * suffixes.
 */
const REF_ISSUING_TOOLS: ReadonlySet<CommandName> = new Set(['snapshot', 'find'] as CommandName[]);

/**
 * `--settle` (#1101) makes an interaction response CONDITIONALLY ref-issuing:
 * when it carries `settle.diff` + `settle.refsGeneration`, the diff's added
 * lines hand out refs minted from the freshly stored settled tree. These tools
 * are NOT in REF_ISSUING_TOOLS on purpose — a plain (non-settle) press carries
 * no generation, and treating that as "issuing response without a generation"
 * would clear the scope's pins on every ordinary tap. Absent or diff-less
 * settle payloads leave pins untouched.
 */
const SETTLE_REF_ISSUING_TOOLS: ReadonlySet<CommandName> = new Set([
  'press',
  'click',
  'fill',
  'longpress',
] as CommandName[]);

const TARGET_REF_TOOLS: ReadonlySet<CommandName> = new Set([
  'press',
  'click',
  'fill',
  'longpress',
  'get',
] as CommandName[]);

/**
 * Bound on remembered pins per scope. Refs still alive keep getting re-merged
 * at the latest generation by every snapshot, so evicting the least recently
 * ISSUED pins only degrades stale-ref precision back to the coarse floor.
 */
const MAX_REF_PINS_PER_SCOPE = 1000;

/**
 * Pin scope: state dir + session name. `stateDir` is a per-tool-call MCP
 * config field, so one MCP server process can serve daemons in different
 * state dirs — two same-named sessions there are different sessions and must
 * not cross-pollinate generations.
 */
function readPinScopeKey(config: McpToolConfig, input: unknown): string {
  const record = asOptionalRecord(input);
  const session = record?.session;
  const sessionName = typeof session === 'string' && session.length > 0 ? session : 'default';
  // NUL separator: neither state-dir paths nor session names contain it.
  return `${config.client.stateDir ?? ''}\u0000${sessionName}`;
}

/**
 * MERGE-ONLY update rule: refs present in the issuing response move to its
 * generation; absent refs keep their older pins (an old pin on a replaced
 * tree is exactly what makes the daemon warn). A ref-issuing response WITHOUT
 * a `refsGeneration` (older daemon, find with no ref match) clears the whole
 * scope — never guess.
 */
function mergeIssuedRefPins(
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
  name: CommandName,
  result: unknown,
): void {
  if (SETTLE_REF_ISSUING_TOOLS.has(name)) {
    mergeSettleIssuedRefPins(refPinsByScope, scopeKey, result);
    return;
  }
  if (!REF_ISSUING_TOOLS.has(name)) return;
  const record = asOptionalRecord(result);
  const refsGeneration = record?.refsGeneration;
  if (record === undefined || typeof refsGeneration !== 'number') {
    refPinsByScope.delete(scopeKey);
    return;
  }
  mergeIntoScopedPins(refPinsByScope, scopeKey, readIssuedRefBodies(record), refsGeneration);
}

/**
 * MERGE-ONLY, like the snapshot/find rule: refs on the settled diff's added
 * lines (plus the unchanged-interactive `tail`, when present) move to the
 * settle generation; every other pin stays put (the settle capture replaced
 * the tree, so an old pin on an unchanged-looking element is exactly what
 * makes the daemon warn precisely). No settle payload, no diff, no digest
 * refs, or no generation → not an issuing response; pins are left untouched.
 */
function mergeSettleIssuedRefPins(
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
  result: unknown,
): void {
  const settle = asOptionalRecord(asOptionalRecord(result)?.settle);
  if (!settle) return;
  const refsGeneration = settle?.refsGeneration;
  if (typeof refsGeneration !== 'number') return;
  const lines = asOptionalRecord(settle?.diff)?.lines;
  const issuedRefs: string[] = [];
  collectRefBodies(lines, issuedRefs);
  collectRefBodies(settle.refs, issuedRefs);
  collectRefBodies(settle.tail, issuedRefs);
  mergeIntoScopedPins(refPinsByScope, scopeKey, issuedRefs, refsGeneration);
}

/** Shared merge-only tail: skip empty issuance, else create-or-reuse the scope's pin map and record. */
function mergeIntoScopedPins(
  refPinsByScope: Map<string, Map<string, number>>,
  scopeKey: string,
  issuedRefs: string[],
  refsGeneration: number,
): void {
  if (issuedRefs.length === 0) return;
  const pins = refPinsByScope.get(scopeKey) ?? new Map<string, number>();
  refPinsByScope.set(scopeKey, pins);
  recordIssuedPins(pins, issuedRefs, refsGeneration);
}

function recordIssuedPins(
  pins: Map<string, number>,
  issuedRefs: string[],
  refsGeneration: number,
): void {
  for (const ref of issuedRefs) {
    // delete-then-set keeps Map insertion order = issue recency for the cap.
    pins.delete(ref);
    pins.set(ref, refsGeneration);
  }
  while (pins.size > MAX_REF_PINS_PER_SCOPE) {
    const oldest = pins.keys().next().value;
    if (oldest === undefined) break;
    pins.delete(oldest);
  }
}

/** Ref bodies (`e12`, no `@`) issued by a snapshot/find response. */
function readIssuedRefBodies(record: Record<string, unknown>): string[] {
  const bodies: string[] = [];
  // find: the single returned ref (`@e12`).
  if (typeof record.ref === 'string' && record.ref.startsWith('@')) {
    bodies.push(record.ref.slice(1));
  }
  // snapshot (default level): every node carries its ref.
  collectRefBodies(record.nodes, bodies);
  // snapshot (digest level): the capped `{ ref, label }` list.
  collectRefBodies(record.refs, bodies);
  return bodies;
}

function collectRefBodies(entries: unknown, into: string[]): void {
  if (!Array.isArray(entries)) return;
  for (const entry of entries) {
    const ref = asOptionalRecord(entry)?.ref;
    if (typeof ref === 'string' && ref.length > 0) into.push(ref);
  }
}

function pinPlainRefArguments(
  name: CommandName,
  input: unknown,
  pins: Map<string, number> | undefined,
): unknown {
  // No remembered pins for this scope → pass refs through unpinned.
  if (pins === undefined || pins.size === 0) return input;
  const record = asOptionalRecord(input);
  if (!record) return input;
  if (name === 'wait') return pinWaitRef(record, pins) ?? input;
  if (TARGET_REF_TOOLS.has(name)) return pinTargetRef(record, pins) ?? input;
  return input;
}

function pinWaitRef(
  record: Record<string, unknown>,
  pins: Map<string, number>,
): Record<string, unknown> | undefined {
  if (typeof record.ref !== 'string') return undefined;
  const pinned = pinRef(record.ref, pins);
  return pinned === record.ref ? undefined : { ...record, ref: pinned };
}

function pinTargetRef(
  record: Record<string, unknown>,
  pins: Map<string, number>,
): Record<string, unknown> | undefined {
  const target = asOptionalRecord(record.target);
  if (target?.kind !== 'ref' || typeof target.ref !== 'string') return undefined;
  const pinned = pinRef(target.ref, pins);
  return pinned === target.ref ? undefined : { ...record, target: { ...target, ref: pinned } };
}

function pinRef(ref: string, pins: Map<string, number>): string {
  // Only pin the canonical plain form `@e12`: an existing `~` means the ref is
  // already pinned (or malformed — the daemon owns rejecting that), and a
  // missing `@` prefix is not a ref the daemon would accept anyway. Refs with
  // no recorded provenance pass through unpinned — never guess.
  if (!ref.startsWith('@') || ref.includes('~')) return ref;
  const generation = pins.get(ref.slice(1));
  return generation === undefined ? ref : `${ref}~s${generation}`;
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
  const { createAgentDeviceClient } = await import('../agent-device-client.ts');
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
