import { listCommandTools, commandToolExecutor, type ToolResult } from './command-tools.ts';
import { readVersion } from '../utils/version.ts';
import type { JsonRpcId, JsonRpcRequestEnvelope } from '../kernel/contracts.ts';
import { AppError, normalizeError } from '../kernel/errors.ts';

const MCP_SERVER_NAME = 'agent-device';
const SUPPORTED_PROTOCOL_VERSION = '2025-11-25';

export type JsonRpcMessage = JsonRpcRequestEnvelope;

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: JsonRpcId; result: unknown }
  | { jsonrpc: '2.0'; id: JsonRpcId; error: { code: number; message: string } };

export async function handleMcpMessage(message: JsonRpcMessage): Promise<JsonRpcResponse | null> {
  if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return errorResponse(message.id ?? null, -32600, 'Invalid JSON-RPC request.');
  }
  // Notifications such as notifications/initialized intentionally do not receive responses.
  if (message.id === undefined) return null;

  try {
    return successResponse(message.id, await handleRequest(message.method, message.params));
  } catch (error) {
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

async function handleRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: supportedProtocolVersion(params),
        capabilities: {
          tools: {},
        },
        serverInfo: {
          name: MCP_SERVER_NAME,
          version: readVersion(),
        },
      };
    case 'ping':
      return {};
    case 'tools/list':
      return { tools: listCommandTools() };
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
    return await commandToolExecutor.execute(name, record.arguments);
  } catch (error) {
    return textToolResult(formatToolError(error), true);
  }
}

// Keep the full error contract (code + hint) visible to MCP agents; a bare
// message string strips exactly the guidance the hint system exists to give.
function formatToolError(error: unknown): string {
  const normalized = normalizeError(error);
  const lines = [`Error (${normalized.code}): ${normalized.message}`];
  if (normalized.hint) lines.push(`Hint: ${normalized.hint}`);
  if (normalized.supportedOn) lines.push(`Supported on: ${normalized.supportedOn}`);
  return lines.join('\n');
}

function supportedProtocolVersion(_params: unknown): string {
  return SUPPORTED_PROTOCOL_VERSION;
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

function errorResponse(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError('INVALID_ARGS', 'Expected object parameters.');
  }
  return value as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new AppError('INVALID_ARGS', `Expected ${key} to be a non-empty string.`);
  }
  return value;
}

class JsonRpcMethodNotFoundError extends Error {}
