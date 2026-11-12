import { expect, test } from 'vitest';
import type { CommandName, JsonSchema } from '@agent-device/command-surface';
import { createMcpMessageHandler } from '../../src/mcp/router.ts';
import { validateAgainstSchema } from '../../src/mcp/__tests__/output-schema-validator.ts';
import { captureOutputEconomyDaemonResponses } from './daemon-route-fixtures.ts';

const daemon = await captureOutputEconomyDaemonResponses();

// Real daemon output at each response level, keyed by the command that produced it.
const samples: Array<[string, CommandName, Record<string, unknown>]> = [
  ['snapshot default', 'snapshot', daemon.snapshotDefault],
  ['snapshot digest', 'snapshot', daemon.snapshotDigest],
  ['get default', 'get', daemon.selectorDefault],
  ['get digest', 'get', daemon.selectorDigest],
  ['settled click default', 'click', daemon.settleDefault],
  ['settled click digest', 'click', daemon.settleDigest],
  ['settled click tail default', 'click', daemon.settleTailDefault],
  ['settled click tail digest', 'click', daemon.settleTailDigest],
  ['screenshot default', 'screenshot', daemon.screenshotDefault],
  ['screenshot digest', 'screenshot', daemon.screenshotDigest],
  ['network default', 'network', daemon.networkDefault],
  ['network digest', 'network', daemon.networkDigest],
];

// The schemas a client of `agent-device mcp --structured` reads from tools/list: only that mode
// advertises outputSchemas, and its typed tools return the daemon data as structuredContent.
const listed = await createMcpMessageHandler({ structured: true })({
  jsonrpc: '2.0',
  id: 'list',
  method: 'tools/list',
});
if (!listed || !('result' in listed)) throw new Error('tools/list failed');
const tools = (listed.result as { tools: Array<{ name: string; outputSchema?: JsonSchema }> })
  .tools;
const outputSchemas = new Map(tools.map((tool) => [tool.name, tool.outputSchema]));
// A sample is checked once its tool advertises an outputSchema; untyped tools have nothing to violate.
const typedSamples = samples.flatMap(([label, name, data]) => {
  const schema = outputSchemas.get(name);
  return schema ? [[label, schema, data] as const] : [];
});

test.each(typedSamples)(
  '%s validates against the advertised MCP outputSchema',
  (_label, schema, data) => {
    expect(validateAgainstSchema(data, schema)).toEqual([]);
  },
);

test('settled interaction output is checked at both response levels', () => {
  expect(typedSamples.map(([label]) => label)).toEqual(
    expect.arrayContaining(['settled click default', 'settled click digest']),
  );
});
