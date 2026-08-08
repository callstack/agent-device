import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import { listMcpExposedCommandNames } from '../../core/command-descriptor/registry.ts';
import { handleMcpMessage } from '../router.ts';
import { createMcpPayloadQueue, handleMcpPayload } from '../server.ts';

test('MCP exposes every automatable CLI command as a structured direct tool', async () => {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });

  assert.ok(response && 'result' in response);
  const tools = (response.result as { tools: Array<{ name: string }> }).tools.map(
    (tool) => tool.name,
  );
  const expectedToolNames = listMcpExposedCommandNames().sort();

  assert.deepEqual(tools.sort(), expectedToolNames);

  const fillTool = (response.result as { tools: Array<Record<string, unknown>> }).tools.find(
    (tool) => tool.name === 'fill',
  );
  assert.ok(fillTool);
  const fillProperties = (fillTool.inputSchema as { properties: Record<string, unknown> })
    .properties;
  assert.ok(!('positionals' in fillProperties));
  assert.ok('target' in fillProperties);
  assert.ok('recordAs' in fillProperties);

  const batchTool = (response.result as { tools: Array<Record<string, unknown>> }).tools.find(
    (tool) => tool.name === 'batch',
  );
  assert.ok(batchTool);
  assert.ok(!JSON.stringify(batchTool.inputSchema).includes('"positionals"'));
  assert.ok(!JSON.stringify(batchTool.inputSchema).includes('"flags"'));

  const invalidFillResponse = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: { name: 'fill', arguments: {} },
  });
  assert.ok(invalidFillResponse && 'result' in invalidFillResponse);
  assert.equal((invalidFillResponse.result as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(invalidFillResponse.result), /Expected target to be set/);

  const malformedArgumentsResponse = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'devices', arguments: [] },
  });
  assert.ok(malformedArgumentsResponse && 'result' in malformedArgumentsResponse);
  assert.equal((malformedArgumentsResponse.result as { isError: boolean }).isError, true);
  assert.match(JSON.stringify(malformedArgumentsResponse.result), /Expected object parameters/);
});

const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 'ModernClient', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': {},
};

test('server/discover advertises both eras so a dual-era client stays modern', async () => {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'discover',
    method: 'server/discover',
    params: { _meta: MODERN_META },
  });

  assert.ok(response && 'result' in response);
  const result = response.result as Record<string, any>;
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result.supportedVersions, ['2026-07-28', '2025-11-25', '2025-06-18']);
  assert.deepEqual(result.capabilities, { tools: {} });
  assert.equal(result.cacheScope, 'public');
  assert.ok(result.ttlMs > 0);
  assert.equal(result._meta['io.modelcontextprotocol/serverInfo'].name, 'agent-device');
});

test('MCP initialize answers with the legacy revision the client asked for', async () => {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'c', version: '1' },
    },
  });

  assert.ok(response && 'result' in response);
  // Answering an unrequested revision makes a pinned client disconnect.
  assert.equal((response.result as { protocolVersion: string }).protocolVersion, '2025-06-18');
});

test('modern tools/list carries the cacheable-result envelope, legacy stays unchanged', async () => {
  const modern = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'modern',
    method: 'tools/list',
    params: { _meta: MODERN_META },
  });
  assert.ok(modern && 'result' in modern);
  const modernResult = modern.result as Record<string, any>;
  assert.equal(modernResult.resultType, 'complete');
  assert.equal(modernResult.cacheScope, 'public');
  assert.ok(modernResult.ttlMs > 0);

  const legacy = await handleMcpMessage({ jsonrpc: '2.0', id: 'legacy', method: 'tools/list' });
  assert.ok(legacy && 'result' in legacy);
  // Legacy clients must see exactly the payload earlier releases sent.
  assert.deepEqual(Object.keys(legacy.result as object), ['tools']);
});

test('a request declaring a 2025 revision is answered on the legacy wire contract', async () => {
  for (const version of ['2025-11-25', '2025-06-18']) {
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: `declared-${version}`,
      method: 'tools/list',
      params: { _meta: { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': version } },
    });

    assert.ok(response && 'result' in response);
    // Declaring a revision through modern framing does not opt it into the 2026 result
    // shape: `resultType`, `serverInfo`, and the cache hints are all 2026-only fields.
    assert.deepEqual(Object.keys(response.result as object), ['tools']);
  }
});

test('initialize does not agree to a modern revision, which has no handshake', async () => {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'initialize-modern',
    method: 'initialize',
    params: {
      protocolVersion: '2026-07-28',
      capabilities: {},
      clientInfo: { name: 'c', version: '1' },
    },
  });

  assert.ok(response && 'result' in response);
  assert.equal((response.result as { protocolVersion: string }).protocolVersion, '2025-11-25');
});

test('server/discover rejects requests missing the modern metadata it requires', async () => {
  const noMeta = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'discover-no-meta',
    method: 'server/discover',
  });
  assert.ok(noMeta && 'error' in noMeta);
  assert.equal(noMeta.error.code, -32602);
  assert.match(noMeta.error.message, /protocolVersion/);

  const legacyVersion = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'discover-legacy',
    method: 'server/discover',
    params: {
      _meta: { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': '2025-11-25' },
    },
  });
  assert.ok(legacyVersion && 'error' in legacyVersion);
  assert.equal(legacyVersion.error.code, -32022);
});

test('a declared revision without client capabilities is rejected as invalid params', async () => {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'no-capabilities',
    method: 'tools/list',
    params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } },
  });

  assert.ok(response && 'error' in response);
  assert.equal(response.error.code, -32602);
  assert.match(response.error.message, /clientCapabilities/);
});

test('modern-framed calls to the methods 2026-07-28 removed are unknown methods', async () => {
  for (const method of ['initialize', 'ping']) {
    const modern = await handleMcpMessage({
      jsonrpc: '2.0',
      id: `modern-${method}`,
      method,
      params: { _meta: MODERN_META },
    });
    assert.ok(modern && 'error' in modern);
    assert.equal(modern.error.code, -32601);

    // The same method stays available to a legacy-framed caller.
    const legacy = await handleMcpMessage({ jsonrpc: '2.0', id: `legacy-${method}`, method });
    assert.ok(legacy && 'result' in legacy);
  }
});

test('a supplied clientInfo must be a valid Implementation', async () => {
  const valid = { name: 'c', version: '1' };
  for (const clientInfo of [
    42,
    { name: 'c' },
    { version: '1' },
    { name: 1, version: 2 },
    // Recognized optional fields are typed, so a wrong scalar is malformed too.
    { ...valid, websiteUrl: 42 },
    { ...valid, title: 42 },
    { ...valid, description: 42 },
    // Icons: wrong container, entry missing `src`, and a bad typed member.
    { ...valid, icons: 42 },
    { ...valid, icons: [{}] },
    { ...valid, icons: [{ src: 42 }] },
    { ...valid, icons: [{ src: 'https://e.dev/i.png', theme: 'blue' }] },
    { ...valid, icons: [{ src: 'https://e.dev/i.png', sizes: [48] }] },
  ]) {
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 'bad-client-info',
      method: 'tools/list',
      params: { _meta: { ...MODERN_META, 'io.modelcontextprotocol/clientInfo': clientInfo } },
    });

    assert.ok(
      response && 'error' in response,
      `expected rejection for ${JSON.stringify(clientInfo)}`,
    );
    assert.equal(response.error.code, -32602);
    assert.match(response.error.message, /clientInfo/);
  }

  // Absent clientInfo is legitimate: the field is optional in 2026-07-28.
  const omitted = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'no-client-info',
    method: 'tools/list',
    params: {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  });
  assert.ok(omitted && 'result' in omitted);

  // `name` and `version` are required `string` with no minimum length, so an empty
  // string is a conforming Implementation and must not be rejected.
  const emptyStrings = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'empty-client-info',
    method: 'tools/list',
    params: {
      _meta: {
        ...MODERN_META,
        'io.modelcontextprotocol/clientInfo': { name: '', version: '' },
      },
    },
  });
  assert.ok(emptyStrings && 'result' in emptyStrings);

  // A fully populated clientInfo, plus an extension key, must still be served:
  // validation must not harden into rejecting what the spec allows.
  const rich = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'rich-client-info',
    method: 'tools/list',
    params: {
      _meta: {
        ...MODERN_META,
        'io.modelcontextprotocol/clientInfo': {
          name: 'c',
          version: '1',
          title: 'Client',
          description: 'A client',
          websiteUrl: 'https://example.dev',
          icons: [
            {
              src: 'https://example.dev/i.png',
              mimeType: 'image/png',
              sizes: ['48x48'],
              theme: 'dark',
            },
          ],
          'com.example/extension': { anything: true },
        },
      },
    },
  });
  assert.ok(rich && 'result' in rich);
});

test('a protocol version this server does not implement is rejected with the supported list', async () => {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 'bad-version',
    method: 'tools/call',
    params: {
      _meta: { ...MODERN_META, 'io.modelcontextprotocol/protocolVersion': '1900-01-01' },
      name: 'devices',
      arguments: {},
    },
  });

  assert.ok(response && 'error' in response);
  assert.equal(response.error.code, -32022);
  assert.deepEqual(response.error.data, {
    supported: ['2026-07-28', '2025-11-25', '2025-06-18'],
    requested: '1900-01-01',
  });
});

test('MCP JSON-RPC batches return responses in request order and skip notifications', async () => {
  const response = await handleMcpPayload([
    { jsonrpc: '2.0', id: 'first', method: 'ping' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'second', method: 'ping' },
  ]);

  assert.deepEqual(
    (response as Array<{ id: string }>).map((entry) => entry.id),
    ['first', 'second'],
  );
});

test('MCP stdio payload queue serializes separate messages', async () => {
  const started: JsonRpcId[] = [];
  const writes: unknown[] = [];
  const completions = new Map<JsonRpcId, (response: unknown) => void>();
  const queue = createMcpPayloadQueue({
    handlePayload: async (message) => {
      const id = Array.isArray(message) ? null : ((message as { id?: JsonRpcId }).id ?? null);
      started.push(id);
      return await new Promise((resolve) => completions.set(id, resolve));
    },
    write: (message) => {
      writes.push(message);
    },
  });

  queue.push({ jsonrpc: '2.0', id: 'first', method: 'tools/call' });
  queue.push({ jsonrpc: '2.0', id: 'second', method: 'tools/call' });
  await Promise.resolve();

  assert.deepEqual(started, ['first']);
  completions.get('first')?.({ jsonrpc: '2.0', id: 'first', result: {} });
  await setImmediate();

  assert.deepEqual(started, ['first', 'second']);
  completions.get('second')?.({ jsonrpc: '2.0', id: 'second', result: {} });
  await queue.idle();

  assert.deepEqual(
    writes.map((message) => (message as { id: JsonRpcId }).id),
    ['first', 'second'],
  );
});

type JsonRpcId = string | number | null;
