import {
  createCommandToolExecutor,
  listCommandTools,
  type CommandToolExecutor,
  type ToolResult,
} from './command-tools.ts';
import type { JsonRpcId, JsonRpcRequestEnvelope } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import {
  callHelpTool,
  HELP_TOOL_NAME,
  HELP_TOOL,
  MCP_SERVER_INSTRUCTIONS,
} from './server-guide.ts';
import {
  cacheFields,
  finalizeResult,
  isMethodRemovedInEra,
  MODERN_PROTOCOL_VERSION,
  negotiateLegacyProtocolVersion,
  resolveProtocolEra,
  serverInfo,
  SUPPORTED_PROTOCOL_VERSIONS,
  STATIC_RESULT_CACHE_TTL_MS,
  UNSUPPORTED_PROTOCOL_VERSION_CODE,
  UnsupportedProtocolVersionError,
  type ProtocolEra,
} from './protocol-era.ts';

export type JsonRpcMessage = JsonRpcRequestEnvelope;

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

type McpMessageContext = { signal?: AbortSignal };

export type McpMessageHandler = (
  message: JsonRpcMessage,
  context?: McpMessageContext,
) => Promise<JsonRpcResponse | null>;

/**
 * One server's tools and results. Results are text only by default: no tool advertises an
 * outputSchema and no result carries `structuredContent`, because clients that show the model
 * `structuredContent` would replace the compact text with JSON. `structured` (`agent-device mcp
 * --structured`) advertises outputSchemas and returns the `structuredContent` that matches them.
 */
export function createMcpMessageHandler(options: { structured: boolean }): McpMessageHandler {
  const server: McpServer = {
    structured: options.structured,
    executor: createCommandToolExecutor(
      options.structured ? { structuredContent: 'declared' } : {},
    ),
  };
  return async (message, context = {}) => await handleServerMessage(server, message, context);
}

/** The default server's handler: text-only results. */
export const handleMcpMessage = createMcpMessageHandler({ structured: false });

type McpServer = { structured: boolean; executor: CommandToolExecutor };

/** `signal` aborts a `tools/call` the client cancelled; other methods finish too fast to need it. */
async function handleServerMessage(
  server: McpServer,
  message: JsonRpcMessage,
  context: McpMessageContext,
): Promise<JsonRpcResponse | null> {
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return errorResponse(message.id ?? null, -32600, 'Invalid JSON-RPC request.');
  }
  // Notifications such as notifications/initialized intentionally do not receive responses.
  if (message.id === undefined) return null;

  try {
    const era = resolveProtocolEra(message.method, message.params);
    const result = await handleRequest(server, message.method, message.params, era, context.signal);
    return successResponse(message.id, finalizeResult(result, era));
  } catch (error) {
    if (error instanceof UnsupportedProtocolVersionError) {
      return errorResponse(
        message.id,
        UNSUPPORTED_PROTOCOL_VERSION_CODE,
        error.message,
        error.data,
      );
    }
    if (error instanceof JsonRpcMethodNotFoundError) {
      return errorResponse(message.id, -32601, error.message);
    }
    return errorResponse(
      message.id,
      -32602,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function handleRequest(
  server: McpServer,
  method: string,
  params: unknown,
  era: ProtocolEra,
  signal: AbortSignal | undefined,
): Promise<unknown> {
  if (isMethodRemovedInEra(method, era)) {
    throw new JsonRpcMethodNotFoundError(
      `${method} was removed in MCP ${MODERN_PROTOCOL_VERSION}.`,
    );
  }
  switch (method) {
    // Modern capability discovery. Servers MUST implement it, and dual-era clients use it
    // as the stdio probe that tells a 2026-07-28 server from a handshake-only one.
    case 'server/discover':
      return {
        supportedVersions: SUPPORTED_PROTOCOL_VERSIONS,
        capabilities: { tools: {} },
        instructions: MCP_SERVER_INSTRUCTIONS,
        // A `DiscoverResult` is always a `CacheableResult`: these are required fields
        // here, not the era-dependent hints `tools/list` adds.
        ttlMs: STATIC_RESULT_CACHE_TTL_MS,
        cacheScope: 'public',
      };
    // Legacy handshake, gated above to legacy-framed requests. Retained so clients on
    // 2025-11-25 and earlier keep connecting.
    case 'initialize':
      return {
        protocolVersion: negotiateLegacyProtocolVersion(params),
        capabilities: {
          tools: {},
        },
        serverInfo: serverInfo(),
        // Legacy clients (Codex CLI among them) read their workflow card from the
        // handshake; `instructions` is an optional InitializeResult field in every
        // legacy revision served here.
        instructions: MCP_SERVER_INSTRUCTIONS,
      };
    // Removed in 2026-07-28; still the keepalive legacy clients rely on.
    case 'ping':
      return {};
    case 'tools/list':
      // Descriptor tools plus the MCP-only guide tool. `listCommandTools()` stays
      // descriptor-only because the AI SDK surface reuses it; the composition is the
      // router's.
      return {
        tools: [...listCommandTools({ outputSchemas: server.structured }), HELP_TOOL],
        ...cacheFields(era, STATIC_RESULT_CACHE_TTL_MS),
      };
    case 'tools/call':
      return await callTool(server.executor, params, signal);
    default:
      throw new JsonRpcMethodNotFoundError(`Unsupported MCP method: ${method}`);
  }
}

async function callTool(
  executor: CommandToolExecutor,
  params: unknown,
  signal: AbortSignal | undefined,
): Promise<ToolResult> {
  const record = asRecord(params);
  const name = stringField(record, 'name');
  try {
    if (name === HELP_TOOL_NAME) return callHelpTool(optionalArguments(record.arguments));
    // Command-level failures are handled (and ref-pinned) by the executor's
    // own catch; this one covers failures outside a resolved command call
    // (unknown tool name, malformed params).
    return await executor.execute(name, optionalArguments(record.arguments), { signal });
  } catch (error) {
    return await executor.errorResult(error);
  }
}

function successResponse(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result };
}

function errorResponse(
  id: JsonRpcId,
  code: number,
  message: string,
  data?: unknown,
): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'Expected object parameters.');
  }
  return value as Record<string, unknown>;
}

function optionalArguments(value: unknown): Record<string, unknown> {
  return value === undefined ? {} : asRecord(value);
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a non-empty string.`);
  }
  return value;
}

class JsonRpcMethodNotFoundError extends Error {}
