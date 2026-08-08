import { listCommandTools, commandToolExecutor, type ToolResult } from './command-tools.ts';
import type { JsonRpcId, JsonRpcRequestEnvelope } from '@agent-device/kernel/contracts';
import { AppError } from '@agent-device/kernel/errors';
import { formatToolErrorText, normalizeToolError } from './tool-error.ts';
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

const SERVER_INSTRUCTIONS =
  'agent-device drives iOS, Android, tvOS, Android TV, macOS, Linux, and web targets. ' +
  'Each tool mirrors the CLI command of the same name; tool descriptions carry the per-command contract.';

export type JsonRpcMessage = JsonRpcRequestEnvelope;

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string; data?: unknown } };

export async function handleMcpMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return errorResponse(message.id ?? null, -32600, 'Invalid JSON-RPC request.');
  }
  // Notifications such as notifications/initialized intentionally do not receive responses.
  if (message.id === undefined) return null;

  try {
    const era = resolveProtocolEra(message.method, message.params);
    const result = await handleRequest(message.method, message.params, era);
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

async function handleRequest(method: string, params: unknown, era: ProtocolEra): Promise<unknown> {
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
        instructions: SERVER_INSTRUCTIONS,
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
      };
    // Removed in 2026-07-28; still the keepalive legacy clients rely on.
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listCommandTools(), ...cacheFields(era, STATIC_RESULT_CACHE_TTL_MS) };
    case 'tools/call':
      return await callTool(params);
    default:
      throw new JsonRpcMethodNotFoundError(`Unsupported MCP method: ${method}`);
  }
}

async function callTool(params: unknown): Promise<ToolResult> {
  const record = asRecord(params);
  const name = stringField(record, 'name');
  try {
    // Command-level failures are handled (and ref-pinned) by the executor's
    // own catch; this one covers failures outside a resolved command call
    // (unknown tool name, malformed params).
    return await commandToolExecutor.execute(name, optionalArguments(record.arguments));
  } catch (error) {
    return textToolResult(formatToolErrorText(normalizeToolError(error)), true);
  }
}

function textToolResult(text: string, isError = false): ToolResult {
  return {
    isError,
    content: [{ type: 'text', text }],
  };
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
