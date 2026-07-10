import { listCommandTools, commandToolExecutor, type ToolResult } from './command-tools.ts';
import { readVersion } from '../utils/version.ts';
import type { JsonRpcId, JsonRpcRequestEnvelope } from '../kernel/contracts.ts';
import { AppError } from '../kernel/errors.ts';
import { formatToolErrorText, normalizeToolError } from './tool-error.ts';

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
    // The executor's own catch (command-tools.ts) handles command-level
    // failures (including ADR 0012 replay divergence: it builds
    // structuredContent and pins the error-path screen refs before
    // returning). This catch is the fallback for failures OUTSIDE a resolved
    // command call — unknown tool name, malformed params — which never reach
    // the executor's try/catch at all.
    return await commandToolExecutor.execute(name, record.arguments);
  } catch (error) {
    return textToolResult(formatToolErrorText(normalizeToolError(error)), true);
  }
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
