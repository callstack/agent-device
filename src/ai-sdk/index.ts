import type { jsonSchema, ToolApprovalStatus, ToolSet } from 'ai';
import type { PlatformSelector } from '@agent-device/kernel/device';
import { AppError, type NormalizedError } from '@agent-device/kernel/errors';
import { createAgentDeviceClient } from '../agent-device-client.ts';
import type { AgentDeviceClient } from '../client/client-types.ts';
import type { JsonSchema } from '../commands/command-contract.ts';
import { resolveCommandFrameworkTier } from '../core/command-descriptor/registry.ts';
import { createCommandToolExecutor, listCommandTools } from '../mcp/command-tools.ts';
import { MCP_TOOL_CONFIG_KEYS } from '../mcp/tool-control-fields.ts';
import { formatToolErrorText } from '../mcp/tool-error.ts';

/**
 * `'core'` — the curated perceive/act loop (see the `frameworkTier` pinning
 * test in `src/core/command-descriptor/__tests__/parity.test.ts`). `'all'`
 * exposes every MCP-exposed command, same set the MCP server surfaces.
 */
export type AgentDeviceToolSet = 'core' | 'all';

export type CreateAgentDeviceToolsOptions = {
  /**
   * The agent-device session every tool call targets. Required: pinning one
   * session here is what lets the model call these tools without ever seeing
   * (or being able to typo) a session name — mirroring the "keep the client
   * outside tool execution so calls share one named session" guidance in the
   * AI SDK doc.
   */
  session: string;
  /**
   * When set, pins every tool call to this platform the same way `session` is
   * pinned, and removes `platform` from the tools' input schemas. Omit it to
   * let each call (and the daemon's own default-device selection) decide.
   */
  platform?: PlatformSelector;
  /** Which tools to build. Defaults to `'core'`. */
  set?: AgentDeviceToolSet;
  /**
   * Per-command approval policy, keyed by command name (e.g. `install`,
   * `close`). Returned as `toolApproval`, ready to pass straight to
   * `ToolLoopAgent`/`generateText`/`streamText` — see
   * https://ai-sdk.dev/docs/agents/tool-approvals. `tool()`'s own
   * `needsApproval` option is deprecated in favor of this, so this factory
   * never sets it.
   */
  approval?: Partial<Record<string, ToolApprovalStatus>>;
};

export type AgentDeviceTools = {
  tools: ToolSet;
  client: AgentDeviceClient;
  toolApproval?: Partial<Record<string, ToolApprovalStatus>>;
};

// Hidden unconditionally, from both the schema the model sees and the input
// `execute` forwards to the shared executor:
//  - `session` is always pinned by this factory — the whole point is that a
//    tool call can never target a session other than the one passed in.
//  - every MCP tool-config key: `stateDir` selects which daemon state directory
//    (and therefore which daemon/session namespace) a call resolves against, so
//    left model-visible it would let a call escape the pinned session into
//    another daemon's state entirely; the rest shape the response, which is this
//    factory's decision, not the model's (`execute` below returns
//    structuredContent directly and never reads a tool's rendered text).
const ALWAYS_HIDDEN_FIELDS: readonly string[] = ['session', ...MCP_TOOL_CONFIG_KEYS];

// The registry's hand-rolled JsonSchema type and `jsonSchema()`'s expected
// JSONSchema7 (re-exported from @ai-sdk/provider, not from `ai` itself) are
// structurally close but not identical (e.g. `type` is a plain `string`
// here); derive the exact expected type from `jsonSchema` itself instead of
// adding a dependency on @ai-sdk/provider just for this one annotation.
type Json7Schema = Parameters<typeof jsonSchema>[0];

/**
 * Builds an AI SDK tool set from the same command registry the MCP server
 * exposes (`listCommandTools()` / `createCommandToolExecutor()`), so the two
 * integrations stay in lockstep without a hand-maintained tool list. Uses
 * `jsonSchema()` against the registry's JSON Schema directly — no zod layer.
 *
 * `ai` is an optional peer dependency, so it is imported lazily here rather
 * than at module scope: importing `agent-device/ai-sdk` itself never
 * requires `ai` to be installed, only calling this function does.
 *
 * The returned `client` is a plain `agent-device` client for the same
 * session, for the host's own setup/teardown (e.g. `client.apps.open(...)`
 * before the loop, `client.sessions.close()` in a `finally`); the tools
 * themselves execute through the registry's own executor, independent of
 * this instance.
 */
export async function createAgentDeviceTools(
  options: CreateAgentDeviceToolsOptions,
): Promise<AgentDeviceTools> {
  const { jsonSchema, tool } = await importAiSdk();
  const { session, platform, set = 'core', approval } = options;
  const client = createAgentDeviceClient({
    session,
    ...(platform ? { lockPlatform: platform } : {}),
  });
  const executor = createCommandToolExecutor();

  const hiddenFields = new Set<string>(ALWAYS_HIDDEN_FIELDS);
  if (platform) hiddenFields.add('platform');

  const tools: ToolSet = {};
  for (const definition of listCommandTools()) {
    if (set === 'core' && resolveCommandFrameworkTier(definition.name) !== 'core') continue;

    tools[definition.name] = tool({
      description: definition.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        omitSchemaProperties(definition.inputSchema, hiddenFields) as unknown as Json7Schema,
      ),
      ...(definition.outputSchema
        ? { outputSchema: jsonSchema(definition.outputSchema as unknown as Json7Schema) }
        : {}),
      execute: async (input) => {
        // Strip hidden fields from the model's input too, not just the schema
        // it was generated from: `additionalProperties: false` should already
        // reject an out-of-schema field, but the pinned session/state-dir
        // guarantee must hold even if some caller bypasses schema validation.
        const filledInput = {
          ...omitHidden(input, hiddenFields),
          session,
          ...(platform ? { platform } : {}),
        };
        const result = await executor.execute(definition.name, filledInput);
        if (result.isError) {
          // command-tools.ts's executor already normalizes a caught error into
          // this exact shape as `structuredContent` (ADR 0012) — reuse it
          // instead of re-normalizing an already-normalized error.
          const normalized = result.structuredContent as NormalizedError;
          throw new AppError(normalized.code, formatToolErrorText(normalized), normalized.details);
        }
        return result.structuredContent ?? {};
      },
    });
  }

  return { tools, client, ...(approval ? { toolApproval: approval } : {}) };
}

async function importAiSdk(): Promise<typeof import('ai')> {
  try {
    return await import('ai');
  } catch (error) {
    throw new AppError(
      'MISSING_PEER_DEPENDENCY',
      "createAgentDeviceTools() requires the optional peer dependency 'ai'. Install it with `pnpm add ai` (or npm/yarn equivalent).",
      undefined,
      error,
    );
  }
}

function omitSchemaProperties(schema: JsonSchema, hidden: ReadonlySet<string>): JsonSchema {
  if (!schema.properties) return schema;
  const required = schema.required?.filter((key) => !hidden.has(key));
  return {
    ...schema,
    properties: omitHidden(schema.properties, hidden),
    ...(required ? { required } : {}),
  };
}

/** Shared by both the schema (over `.properties`) and the runtime input (over the call itself). */
function omitHidden<T>(record: Record<string, T>, hidden: ReadonlySet<string>): Record<string, T> {
  const result: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!hidden.has(key)) result[key] = value;
  }
  return result;
}
