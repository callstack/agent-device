import { createMcpMessageHandler, type JsonRpcMessage, type McpMessageHandler } from './router.ts';
import { jsonRpcRequestSchema, type JsonRpcId } from '@agent-device/kernel/contracts';

type JsonRpcResponse = NonNullable<Awaited<ReturnType<McpMessageHandler>>>;
type PayloadContext = { signal?: AbortSignal };
type PayloadHandler = (payload: unknown, context: PayloadContext) => Promise<unknown | null>;
type MessageWriter = (message: unknown) => void;

/** `structured`: `agent-device mcp --structured`; see `createMcpMessageHandler`. */
export async function runAgentDeviceMcpServer(options: { structured: boolean }): Promise<void> {
  const session = createMcpStdioSession({ handlePayload: createMcpPayloadHandler(options) });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    session.receive(chunk);
  });
  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
    process.stdin.resume();
  });
  await session.end();
}

/**
 * One stdio connection: newline-delimited JSON-RPC in, responses out.
 *
 * `tools/call` requests run one at a time, in arrival order, because they drive devices and share
 * the executor's ref pins. Every other request, and every batch, is answered at once, so `ping` and
 * `tools/list` never wait behind a long tool call. `notifications/cancelled` aborts the named
 * `tools/call`, queued or running, and the server sends no response for it. A batch never carries
 * a `tools/call`: see `handleMcpBatch`.
 */
export function createMcpStdioSession(options: {
  handlePayload: PayloadHandler;
  write?: MessageWriter;
}): {
  receive: (chunk: string) => void;
  end: () => Promise<void>;
} {
  const handlePayload = options.handlePayload;
  const write = options.write ?? writeMessage;
  const inFlight = new Set<Promise<void>>();
  const toolCalls = new Map<JsonRpcId, AbortController>();
  let toolQueue = Promise.resolve();
  let buffer = '';

  const track = (work: Promise<void>): void => {
    inFlight.add(work);
    void work.finally(() => inFlight.delete(work));
  };

  const respond = async (payload: unknown, signal?: AbortSignal): Promise<void> => {
    try {
      const response = await handlePayload(payload, { signal });
      if (response && !signal?.aborted) write(response);
    } catch (error) {
      if (signal?.aborted) return;
      write({
        jsonrpc: '2.0',
        id: fallbackErrorId(payload),
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  };

  const enqueueToolCall = (payload: unknown, id: JsonRpcId | undefined): void => {
    const controller = new AbortController();
    if (id !== undefined) toolCalls.set(id, controller);
    const run = async (): Promise<void> => {
      if (!controller.signal.aborted) await respond(payload, controller.signal);
      if (id !== undefined && toolCalls.get(id) === controller) toolCalls.delete(id);
    };
    toolQueue = toolQueue.then(run);
    track(toolQueue);
  };

  const dispatch = (payload: unknown): void => {
    const message = singleMessage(payload);
    if (message?.method === 'notifications/cancelled' && message.id === undefined) {
      const id = cancelledRequestId(message.params);
      if (id !== undefined) toolCalls.get(id)?.abort();
      return;
    }
    if (message?.method === 'tools/call') {
      enqueueToolCall(payload, message?.id);
      return;
    }
    track(respond(payload));
  };

  const receiveLine = (rawLine: string): void => {
    const line = rawLine.trim();
    if (line.length === 0) return;
    let payload: unknown;
    try {
      // The decoded value stays untyped here; the payload handler validates it at the boundary.
      payload = JSON.parse(line) as unknown;
    } catch (error) {
      write({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: error instanceof Error ? error.message : String(error) },
      });
      return;
    }
    dispatch(payload);
  };

  return {
    receive: (chunk) => {
      buffer += chunk;
      for (let newline = buffer.indexOf('\n'); newline !== -1; newline = buffer.indexOf('\n')) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        receiveLine(line);
      }
    },
    end: async () => {
      const trailing = buffer;
      buffer = '';
      receiveLine(trailing);
      while (inFlight.size > 0) await Promise.all(inFlight);
    },
  };
}

/** One server's JSON-RPC payload boundary: single messages and legacy batches. */
export function createMcpPayloadHandler(options: { structured: boolean }) {
  const handleMessage = createMcpMessageHandler(options);
  return async (payload: unknown, context: PayloadContext = {}): Promise<unknown | null> =>
    Array.isArray(payload)
      ? await handleMcpBatch(handleMessage, payload)
      : await handleInboundMessage(handleMessage, payload, context);
}

/**
 * JSON-RPC batching exists only for legacy clients (MCP 2025-06-18 removed it). A `tools/call` in a
 * batch is refused with -32600: it could not be cancelled on its own or queued behind other tool
 * calls, so it is accepted only as its own message.
 */
async function handleMcpBatch(
  handleMessage: McpMessageHandler,
  messages: unknown[],
): Promise<JsonRpcResponse[] | null> {
  const responses: JsonRpcResponse[] = [];
  for (const message of messages) {
    const parsed = singleMessage(message);
    const response =
      parsed?.jsonrpc === '2.0' && parsed.method === 'tools/call'
        ? batchedToolCallResponse(parsed.id)
        : await handleInboundMessage(handleMessage, message);
    responses.push(...responseArray(response));
  }
  return responses.length > 0 ? responses : null;
}

/** A notification gets no response, as anywhere else. */
function batchedToolCallResponse(id: JsonRpcId | undefined): JsonRpcResponse | null {
  if (id === undefined) return null;
  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32600,
      message: 'tools/call is not accepted in a JSON-RPC batch. Send it as its own message.',
    },
  };
}

// Parse-at-the-boundary: validate each inbound payload against the shared JSON-RPC
// envelope schema instead of force-casting attacker-controlled wire input. Requests
// (with an id), notifications (no id), and batch elements all stay valid; only
// genuinely malformed payloads (non-object, or wrong-typed jsonrpc/method/id) are
// rejected with the standard -32600 Invalid Request error.
async function handleInboundMessage(
  handleMessage: McpMessageHandler,
  raw: unknown,
  context: PayloadContext = {},
): Promise<JsonRpcResponse | null> {
  let message: JsonRpcMessage;
  try {
    message = jsonRpcRequestSchema.parse(raw);
  } catch {
    return invalidRequestResponse(bestEffortId(raw));
  }
  return handleMessage(message, context);
}

function invalidRequestResponse(id: JsonRpcId): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid JSON-RPC request.' } };
}

function fallbackErrorId(payload: unknown): JsonRpcId {
  if (Array.isArray(payload)) {
    return payload.length === 1 ? bestEffortId(payload[0]) : null;
  }
  return bestEffortId(payload);
}

/** The envelope of a non-batch payload that parses as JSON-RPC; `undefined` otherwise. */
function singleMessage(payload: unknown): JsonRpcMessage | undefined {
  if (Array.isArray(payload)) return undefined;
  try {
    return jsonRpcRequestSchema.parse(payload);
  } catch {
    return undefined;
  }
}

function cancelledRequestId(params: unknown): JsonRpcId | undefined {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return undefined;
  const requestId = (params as Record<string, unknown>).requestId;
  return typeof requestId === 'string' || typeof requestId === 'number' ? requestId : undefined;
}

function bestEffortId(value: unknown): JsonRpcId {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === 'string' || typeof id === 'number' || id === null) {
      return id;
    }
  }
  return null;
}

function responseArray(response: JsonRpcResponse | null): JsonRpcResponse[] {
  return response ? [response] : [];
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
