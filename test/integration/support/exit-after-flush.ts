// #1596/#1706 fixture: writes an oversized payload through a real piped CLI
// process so the parent must receive the trailing marker before either exit.
import https, { type RequestOptions } from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { exitAfterFlush } from '../../../src/cli/process-exit.ts';
import { buildPayload, PAYLOAD_MARKER } from './exit-payload.ts';

const DAEMON_BASE_URL = 'https://agent-device-exit-flush.test/agent-device';
const cliPayloadMarker = process.env.AGENT_DEVICE_TEST_PAYLOAD_MARKER;

if (cliPayloadMarker) {
  installCliTransportFixture(cliPayloadMarker);
} else if (process.argv.includes('--success')) {
  const { runCliProcess } = await import('../../../src/cli/process-entry.ts');
  const { printJson } = await import('../../../src/commands/output/json.ts');
  await runCliProcess([], async () => ({
    runCli: async () => {
      printJson({ success: true, data: { payload: `${'x'.repeat(256_000)}${PAYLOAD_MARKER}` } });
    },
  }));
} else {
  process.stderr.write(buildPayload());
  await exitAfterFlush(1);
}

function installCliTransportFixture(payloadMarker: string): void {
  // Model a daemon transport that keeps background connection bookkeeping
  // alive after it has delivered the response. The public CLI owns its terminal
  // lifecycle: it must flush the response and exit rather than rely on ambient
  // event-loop emptiness.
  setInterval(() => {}, 1_000);
  const fixtureFetch = createFixtureFetch(payloadMarker);
  globalThis.fetch = fixtureFetch;
  Object.defineProperty(https, 'request', {
    configurable: true,
    value: createFetchBackedHttpsRequest(fixtureFetch),
  });
}

function createFixtureFetch(payloadMarker: string): typeof fetch {
  return async (input, init) => await routeFixtureRequest(new Request(input, init), payloadMarker);
}

async function routeFixtureRequest(request: Request, payloadMarker: string): Promise<Response> {
  switch (`${request.method} ${request.url}`) {
    case `GET ${DAEMON_BASE_URL}/health`:
      return jsonResponse({
        ok: true,
        service: 'agent-device-daemon',
        version: '0.20.6',
        rpcProtocolVersion: 2,
      });
    case `POST ${DAEMON_BASE_URL}/rpc`:
      return await rpcResponse(request, payloadMarker);
    default:
      throw new Error(`Unexpected CLI success fixture request: ${request.method} ${request.url}`);
  }
}

async function rpcResponse(request: Request, payloadMarker: string): Promise<Response> {
  const body = (await request.json()) as { id?: string | number | null };
  return jsonResponse({
    jsonrpc: '2.0',
    id: body.id ?? 'cli-success-exit-flush',
    result: {
      ok: true,
      data: {
        nodes: [
          {
            ref: 'e1',
            index: 0,
            depth: 0,
            type: 'StaticText',
            label: `${'x'.repeat(256_000)}${payloadMarker}`,
            enabled: true,
          },
        ],
        truncated: false,
        refsGeneration: 1,
      },
    },
  });
}

type FixtureRequest = EventEmitter & {
  write(chunk: string | Uint8Array): boolean;
  destroy(): void;
  end(): void;
};

type FixtureResponse = Readable & {
  statusCode: number;
  headers: Record<string, string>;
};

function createFetchBackedHttpsRequest(fixtureFetch: typeof fetch) {
  return (options: RequestOptions, callback: (response: FixtureResponse) => void) => {
    const request = new EventEmitter() as FixtureRequest;
    const chunks: Buffer[] = [];
    request.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      return true;
    };
    request.destroy = () => {};
    request.end = () => {
      queueMicrotask(async () => {
        try {
          callback(await fetchNodeResponse(fixtureFetch, options, chunks));
        } catch (error) {
          request.emit('error', error);
        }
      });
    };
    return request;
  };
}

async function fetchNodeResponse(
  fixtureFetch: typeof fetch,
  options: RequestOptions,
  chunks: Buffer[],
): Promise<FixtureResponse> {
  const port = options.port ? `:${options.port}` : '';
  const response = await fixtureFetch(
    `${options.protocol}//${options.host}${port}${options.path}`,
    {
      method: options.method,
      headers: options.headers as HeadersInit,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    },
  );
  const nodeResponse = Readable.from([
    Buffer.from(await response.arrayBuffer()),
  ]) as FixtureResponse;
  nodeResponse.statusCode = response.status;
  nodeResponse.headers = Object.fromEntries(response.headers.entries());
  return nodeResponse;
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
