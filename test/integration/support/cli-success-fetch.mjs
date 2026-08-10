import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const DAEMON_BASE_URL = 'https://agent-device-exit-flush.test/agent-device';
const marker = process.env.AGENT_DEVICE_TEST_PAYLOAD_MARKER;

if (marker) installFixture(marker);

function installFixture(payloadMarker) {
  // Model a daemon transport that keeps background connection bookkeeping
  // alive after it has delivered the response. The public CLI owns its terminal
  // lifecycle: it must flush the response and exit rather than rely on ambient
  // event-loop emptiness.
  setInterval(() => {}, 1_000);
  const fixtureFetch = createFixtureFetch(payloadMarker);
  globalThis.fetch = fixtureFetch;
  https.request = createFetchBackedHttpsRequest(fixtureFetch);
}

function createFixtureFetch(payloadMarker) {
  return async (input, init) => {
    const request = new Request(input, init);
    if (request.method === 'GET' && request.url === `${DAEMON_BASE_URL}/health`) {
      return jsonResponse({
        ok: true,
        service: 'agent-device-daemon',
        version: '0.20.6',
        rpcProtocolVersion: 2,
      });
    }
    if (request.method === 'POST' && request.url === `${DAEMON_BASE_URL}/rpc`) {
      const body = await request.json();
      return jsonResponse({
        jsonrpc: '2.0',
        id: body?.id ?? 'cli-success-exit-flush',
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
    throw new Error(`Unexpected CLI success fixture request: ${request.method} ${request.url}`);
  };
}

function createFetchBackedHttpsRequest(fixtureFetch) {
  return (options, callback) => {
    const request = new EventEmitter();
    const chunks = [];
    request.write = (chunk) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
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

async function fetchNodeResponse(fixtureFetch, options, chunks) {
  const port = options.port ? `:${options.port}` : '';
  const response = await fixtureFetch(
    `${options.protocol}//${options.host}${port}${options.path}`,
    {
      method: options.method,
      headers: options.headers,
      body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
    },
  );
  const nodeResponse = Readable.from([Buffer.from(await response.arrayBuffer())]);
  nodeResponse.statusCode = response.status;
  nodeResponse.headers = Object.fromEntries(response.headers.entries());
  return nodeResponse;
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
