import fs from 'node:fs';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';

const DAEMON_BASE_URL = 'https://agent-device.test/agent-device';
const DEVICES_URL = 'https://api-cloud.browserstack.com/app-automate/devices.json';
const APPS_URL = 'https://api-cloud.browserstack.com/app-automate/recent_apps?limit=100';
const rpcLogPath = process.env.AGENT_DEVICE_TEST_RPC_LOG_PATH;

if (rpcLogPath) installFixture(rpcLogPath);

function installFixture(logPath) {
  const fixtureFetch = createFixtureFetch(logPath);
  globalThis.fetch = fixtureFetch;
  https.request = createFetchBackedHttpsRequest(fixtureFetch);
}

function createFixtureFetch(logPath) {
  const routes = [
    route('GET', DEVICES_URL, () =>
      jsonResponse([
        { os: 'android', os_version: '14.0', device: 'Google Pixel 8', realMobile: true },
      ]),
    ),
    route('GET', APPS_URL, () =>
      jsonResponse([{ app_name: 'sample.apk', app_version: '1.2.3', app_url: 'bs://app-id' }]),
    ),
    route('GET', `${DAEMON_BASE_URL}/health`, () =>
      jsonResponse({
        ok: true,
        service: 'agent-device-daemon',
        version: '0.0.0-test',
        rpcProtocolVersion: 2,
      }),
    ),
    route('POST', `${DAEMON_BASE_URL}/rpc`, async (request) => {
      const body = await request.json();
      fs.appendFileSync(logPath, `${JSON.stringify(body)}\n`);
      return jsonResponse({
        jsonrpc: '2.0',
        id: body?.id ?? 'provider-disconnect-smoke',
        result: { ok: true, data: responseDataForRpc(body) },
      });
    }),
  ];
  return async (input, init) => {
    const request = new Request(input, init);
    const match = routes.find(
      (candidate) => candidate.method === request.method && candidate.url === request.url,
    );
    if (!match) {
      throw new Error(
        `Unexpected fetch in provider disconnect fixture: ${request.method} ${request.url}`,
      );
    }
    return await match.respond(request);
  };
}

function route(method, url, respond) {
  return { method, url, respond };
}

// The built daemon client intentionally uses node:https for streaming RPC.
// Adapt that API to the same fetch fixture so this packaging test exercises
// the shipped daemon client without opening a loopback listener.
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
  const result = await fixtureFetch(`${options.protocol}//${options.host}${port}${options.path}`, {
    method: options.method,
    headers: options.headers,
    body: chunks.length > 0 ? Buffer.concat(chunks) : undefined,
  });
  const response = Readable.from([Buffer.from(await result.arrayBuffer())]);
  response.statusCode = result.status;
  response.headers = Object.fromEntries(result.headers.entries());
  return response;
}

const RPC_METHOD_RESPONSES = {
  'agent_device.lease.allocate': (params) => ({
    lease: {
      leaseId: 'lease-bs-1',
      tenantId: params.tenantId,
      runId: params.runId,
      backend: params.backend,
      leaseProvider: params.leaseProvider,
      clientId: params.clientId,
      deviceKey: params.deviceKey,
    },
  }),
  'agent_device.lease.release': () => ({
    released: true,
    provider: { provider: 'browserstack', providerSessionId: 'bs-session-1' },
  }),
};

const COMMAND_RESPONSES = {
  open: (params) => ({
    session: params.session,
    appName: 'Demo',
    appBundleId: 'com.example.demo',
    platform: 'android',
    target: 'mobile',
    device: 'Pixel',
    id: 'browserstack-pixel',
    serial: 'browserstack-pixel',
  }),
  close: () => ({
    provider: { provider: 'browserstack', providerSessionId: 'bs-session-1' },
  }),
};

function responseDataForRpc(body) {
  const params = body?.params ?? {};
  const respond = RPC_METHOD_RESPONSES[body?.method] ?? COMMAND_RESPONSES[params.command];
  return respond?.(params) ?? {};
}

function jsonResponse(value) {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
