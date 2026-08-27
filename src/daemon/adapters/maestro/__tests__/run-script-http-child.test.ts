import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { beforeEach, test, vi } from 'vitest';
import { AppError } from '@agent-device/kernel/errors';

const mocks = vi.hoisted(() => ({
  approvePublicNetworkUrl: vi.fn(),
  requestApprovedUrl: vi.fn(),
}));

vi.mock('@agent-device/provision-kit/install-source-network', () => ({
  approvePublicNetworkUrl: mocks.approvePublicNetworkUrl,
}));
vi.mock('@agent-device/provision-kit/install-source-network-transport', () => ({
  requestApprovedUrl: mocks.requestApprovedUrl,
}));

import {
  executeRunScriptHttpRequest,
  MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES,
} from '../run-script-http-child.ts';

beforeEach(() => {
  vi.resetAllMocks();
});

test('revalidates every Maestro HTTP redirect before dispatching it', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValueOnce({ address: '93.184.216.34', family: 4 });
  mocks.approvePublicNetworkUrl.mockRejectedValueOnce(
    new AppError(
      'INVALID_ARGS',
      'Maestro runScript URL host is not allowed because it resolves to a non-public address: 127.0.0.1',
    ),
  );
  mocks.requestApprovedUrl.mockResolvedValue(response(302, { location: 'https://127.0.0.1/next' }));

  await assert.rejects(
    executeRunScriptHttpRequest({
      method: 'POST',
      url: 'https://example.test/start',
      headers: { authorization: 'secret', accept: 'application/json' },
      body: '{}',
      networkAccess: 'public-only',
    }),
    /non-public address/,
  );
  assert.equal(mocks.requestApprovedUrl.mock.calls.length, 1);
  assert.equal(mocks.approvePublicNetworkUrl.mock.calls.length, 2);
  assert.equal(mocks.approvePublicNetworkUrl.mock.calls[1]?.[0].href, 'https://127.0.0.1/next');
});

test('follows an approved same-origin Maestro HTTP redirect with fetch semantics', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  mocks.requestApprovedUrl
    .mockResolvedValueOnce(response(302, { location: 'https://example.test/next' }))
    .mockResolvedValueOnce(response(200, {}, 'ok'));

  const result = await executeRunScriptHttpRequest({
    method: 'POST',
    url: 'https://example.test/start',
    headers: { authorization: 'secret' },
    body: '{}',
    networkAccess: 'public-only',
  });

  assert.deepEqual(result, { status: 200, body: 'ok', headers: {} });
  assert.equal(mocks.requestApprovedUrl.mock.calls.length, 2);
  assert.equal(mocks.requestApprovedUrl.mock.calls[1]?.[0].method, 'GET');
  assert.equal(mocks.requestApprovedUrl.mock.calls[1]?.[0].body, undefined);
  assert.equal(mocks.requestApprovedUrl.mock.calls[1]?.[0].headers.authorization, 'secret');
});

test('classifies redirects before reading their response bodies', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  let resumed = false;
  const redirectBody = {
    resume: () => {
      resumed = true;
    },
  } as unknown as NodeJS.ReadableStream;
  mocks.requestApprovedUrl
    .mockResolvedValueOnce(response(302, { location: 'https://example.test/next' }, redirectBody))
    .mockResolvedValueOnce(response(200, {}, 'ok'));

  const result = await executeRunScriptHttpRequest({
    method: 'GET',
    url: 'https://example.test/start',
    headers: {},
    networkAccess: 'public-only',
  });

  assert.equal(result.body, 'ok');
  assert.equal(resumed, true);
});

test('caps final public response bodies while consuming them incrementally', async () => {
  mocks.approvePublicNetworkUrl.mockResolvedValue({ address: '93.184.216.34', family: 4 });
  let yieldedChunks = 0;
  const body = Readable.from(
    (function* () {
      yieldedChunks += 1;
      yield Buffer.alloc(MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES / 2, 0x61);
      yieldedChunks += 1;
      yield Buffer.alloc(MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES / 2, 0x62);
      yieldedChunks += 1;
      yield Buffer.from('overflow');
    })(),
  );
  mocks.requestApprovedUrl.mockResolvedValue(response(200, {}, body));

  await assert.rejects(
    executeRunScriptHttpRequest({
      method: 'GET',
      url: 'https://example.test/large',
      headers: {},
      networkAccess: 'public-only',
    }),
    new RegExp(`response exceeded ${MAX_RUN_SCRIPT_HTTP_RESPONSE_BYTES} bytes`),
  );
  assert.equal(yieldedChunks, 3);
});

function response(
  statusCode: number,
  headers: Record<string, string> = {},
  body: string | NodeJS.ReadableStream = '',
): {
  statusCode: number;
  headers: Record<string, string>;
  body: NodeJS.ReadableStream;
  close: () => Promise<void>;
} {
  return {
    statusCode,
    headers,
    body: typeof body === 'string' ? Readable.from([body]) : body,
    close: async () => {},
  };
}
