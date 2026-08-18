import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import { test } from 'vitest';
import { listCliCommandNames } from '../../command-catalog.ts';
import { helpTopicIds } from '../../cli-schema/cli-help.ts';
import { listMcpExposedCommandNames } from '../../core/command-descriptor/registry.ts';
import { handleMcpMessage } from '../router.ts';
import {
  HELP_TOOL_NAME,
  MCP_SERVER_INSTRUCTIONS,
  terminalOnlyCommandNames,
} from '../server-guide.ts';
import { createMcpPayloadQueue, handleMcpPayload } from '../server.ts';

test('MCP exposes every automatable CLI command as a structured direct tool, plus the MCP-only help tool', async () => {
  const response = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/list',
  });

  assert.ok(response && 'result' in response);
  const tools = (response.result as { tools: Array<{ name: string }> }).tools.map(
    (tool) => tool.name,
  );
  // Descriptor tools plus exactly one router-owned discovery tool: `help` is not a
  // command descriptor (it drives no device), so it must not leak into the CLI/Node
  // surfaces the descriptor registry projects.
  const expectedToolNames = [...listMcpExposedCommandNames(), HELP_TOOL_NAME].sort();

  assert.deepEqual(tools.sort(), expectedToolNames);
  assert.ok(!listMcpExposedCommandNames().includes(HELP_TOOL_NAME as never));

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

// Claude Code truncates server instructions at 2 KB and loads them at session start; the
// card must fit whole, and it must reach both protocol eras (Codex CLI reads it from the
// legacy `initialize` handshake).
const CLAUDE_CODE_INSTRUCTIONS_LIMIT_BYTES = 2048;

test('server instructions are the compact workflow card, under the 2 KB client cap', () => {
  assert.ok(
    Buffer.byteLength(MCP_SERVER_INSTRUCTIONS, 'utf8') < CLAUDE_CODE_INSTRUCTIONS_LIMIT_BYTES,
  );
  // The card must name the start rule and the guide tool, and speak in tool properties.
  assert.match(MCP_SERVER_INSTRUCTIONS, /open \{app, foreground: true\}/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /snapshot \{interactiveOnly: true\}/);
  assert.match(MCP_SERVER_INSTRUCTIONS, /Call help only/);
});

test('legacy initialize carries the same instructions as server/discover', async () => {
  const legacy = await handleMcpMessage({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'c', version: '1' },
    },
  });
  assert.ok(legacy && 'result' in legacy);
  assert.equal((legacy.result as { instructions: string }).instructions, MCP_SERVER_INSTRUCTIONS);
});

test('help tool returns the workflow card, a topic guide, a tool reference, or a listed error', async () => {
  const call = async (args: Record<string, unknown> | undefined) => {
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: HELP_TOOL_NAME, ...(args ? { arguments: args } : {}) },
    });
    assert.ok(response && 'result' in response);
    const result = response.result as { isError: boolean; content: Array<{ text: string }> };
    return { isError: result.isError, text: result.content[0]?.text ?? '' };
  };

  const card = await call(undefined);
  assert.equal(card.isError, false);
  assert.match(card.text, /^CLI syntax over MCP:/);
  assert.match(card.text, /agent-device open <app> --foreground/);

  const topic = await call({ topic: 'gestures' });
  assert.equal(topic.isError, false);
  assert.match(topic.text, /gestures/);

  // A tool name resolves to its full flag reference, aliases included.
  const command = await call({ topic: 'tap' });
  assert.equal(command.isError, false);
  assert.match(command.text, /agent-device press/);

  // `help web` tells the reader to run `agent-device web setup` / `web doctor`; no `web`
  // MCP tool exists, so an MCP-only client must be told those are shell steps. The
  // preamble names every CLI-only command — the exact registry difference, not a scan of
  // the guide's prose — so the claim holds for this guide and every other one.
  const web = await call({ topic: 'web' });
  assert.equal(web.isError, false);
  assert.match(web.text, /agent-device web setup/);
  const terminalOnlyLine = web.text.split('\n').find((line) => line.includes('Terminal-only'));
  assert.ok(terminalOnlyLine);
  assert.match(terminalOnlyLine, /\bweb\b/);
  const listed = terminalOnlyCommandNames();
  const exposed = new Set<string>(listMcpExposedCommandNames());
  for (const name of listed) {
    assert.ok(!exposed.has(name), `${name} is an MCP tool but is listed as terminal-only`);
    assert.ok(terminalOnlyLine.includes(name), `${name} missing from the terminal-only line`);
  }
  assert.deepEqual(
    listCliCommandNames().filter((name) => !exposed.has(name)),
    listed,
  );

  const unknown = await call({ topic: 'no-such-topic' });
  assert.equal(unknown.isError, true);
  for (const id of helpTopicIds()) assert.ok(unknown.text.includes(id), id);

  const malformed = await call({ topic: 42 });
  assert.equal(malformed.isError, true);
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
