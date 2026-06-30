import { handleMcpMessage, type JsonRpcMessage } from './router.ts';
import { jsonRpcRequestSchema, type JsonRpcId } from '../kernel/contracts.ts';

type JsonRpcResponse = Awaited<NonNullable<ReturnType<typeof handleMcpMessage>>>;
type MessageSink = (payload: unknown) => void;
type PayloadHandler = (payload: unknown) => Promise<unknown | null>;
type MessageWriter = (message: unknown) => void;

export async function runAgentDeviceMcpServer(): Promise<void> {
  const payloadQueue = createMcpPayloadQueue();
  const decoder = new McpMessageDecoder((payload) => {
    payloadQueue.push(payload);
  });

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    try {
      decoder.push(chunk);
    } catch (error) {
      writeMessage({
        jsonrpc: '2.0',
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  });

  await new Promise<void>((resolve) => {
    process.stdin.on('end', resolve);
    process.stdin.on('close', resolve);
    process.stdin.resume();
  });
  await payloadQueue.idle();
}

export function createMcpPayloadQueue(
  options: {
    handlePayload?: PayloadHandler;
    write?: MessageWriter;
  } = {},
): {
  push: (payload: unknown) => void;
  idle: () => Promise<void>;
} {
  const handlePayload = options.handlePayload ?? handleMcpPayload;
  const write = options.write ?? writeMessage;
  let pending = Promise.resolve();
  return {
    push: (payload) => {
      const fallbackId = fallbackErrorId(payload);
      pending = pending
        .then(async () => {
          const response = await handlePayload(payload);
          if (response) write(response);
        })
        .catch((error: unknown) => {
          write({
            jsonrpc: '2.0',
            id: fallbackId,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : String(error),
            },
          });
        });
    },
    idle: async () => {
      await pending;
    },
  };
}

export function handleMcpPayload(payload: unknown): Promise<unknown | null> {
  if (Array.isArray(payload)) {
    return handleMcpBatch(payload);
  }
  return handleInboundMessage(payload);
}

async function handleMcpBatch(messages: unknown[]): Promise<JsonRpcResponse[] | null> {
  const responses: JsonRpcResponse[] = [];
  for (const message of messages) {
    responses.push(...responseArray(await handleInboundMessage(message)));
  }
  return responses.length > 0 ? responses : null;
}

// Parse-at-the-boundary: validate each inbound payload against the shared JSON-RPC
// envelope schema instead of force-casting attacker-controlled wire input. Requests
// (with an id), notifications (no id), and batch elements all stay valid; only
// genuinely malformed payloads (non-object, or wrong-typed jsonrpc/method/id) are
// rejected with the standard -32600 Invalid Request error.
async function handleInboundMessage(raw: unknown): Promise<JsonRpcResponse | null> {
  let message: JsonRpcMessage;
  try {
    message = jsonRpcRequestSchema.parse(raw);
  } catch {
    return invalidRequestResponse(bestEffortId(raw));
  }
  return handleMcpMessage(message);
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

function bestEffortId(value: unknown): JsonRpcId {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as Record<string, unknown>).id;
    if (typeof id === 'string' || typeof id === 'number' || id === null) {
      return id;
    }
  }
  return null;
}

class McpMessageDecoder {
  private buffer = '';
  private readonly sink: MessageSink;

  constructor(sink: MessageSink) {
    this.sink = sink;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const line = this.tryReadLineMessage();
      if (line !== undefined) {
        this.emit(line);
        continue;
      }
      break;
    }
  }

  private tryReadLineMessage(): string | undefined {
    const newline = this.buffer.indexOf('\n');
    if (newline === -1) return undefined;
    const line = this.buffer.slice(0, newline).trim();
    this.buffer = this.buffer.slice(newline + 1);
    return line.length > 0 ? line : undefined;
  }

  private emit(raw: string): void {
    // JSON.parse failures propagate to the stdin handler as a -32700 parse error.
    // The decoded value stays untyped here; handleMcpPayload validates it at the boundary.
    this.sink(JSON.parse(raw) as unknown);
  }
}

function responseArray(response: JsonRpcResponse | null): JsonRpcResponse[] {
  return response ? [response] : [];
}

function writeMessage(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
