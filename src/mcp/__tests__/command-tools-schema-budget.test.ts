import assert from 'node:assert/strict';
import { test } from 'vitest';
import { COMMON_INPUT_AUDIENCE, listCommandMetadata } from '@agent-device/command-surface';
import { listCommandTools } from '../command-tools.ts';
import { CONFIG_LOADER_AUDIENCE, MCP_TOOL_CONFIG_AUDIENCE } from '../tool-control-fields.ts';

// Clients that compact large tool schemas drop descriptions and nested structure above about
// 5 KB, and clients that defer tool schemas append the full schema to every error result.
const INPUT_SCHEMA_BUDGET_BYTES = 5 * 1024;

test('every MCP tool input schema stays within the byte budget', () => {
  const oversized = listCommandTools()
    .map((tool) => ({
      name: tool.name,
      bytes: Buffer.byteLength(JSON.stringify(tool.inputSchema)),
    }))
    .filter((tool) => tool.bytes > INPUT_SCHEMA_BUDGET_BYTES);
  assert.deepEqual(oversized, []);
});

test('no MCP tool advertises an operator-owned input', () => {
  const audiences = [
    COMMON_INPUT_AUDIENCE,
    MCP_TOOL_CONFIG_AUDIENCE,
    CONFIG_LOADER_AUDIENCE,
    ...listCommandMetadata().map((metadata) => metadata.inputAudience),
  ];
  const operatorKeys = new Set(
    audiences.flatMap((audience) =>
      Object.entries(audience).flatMap(([key, entry]) => (entry.kind === 'operator' ? [key] : [])),
    ),
  );
  for (const key of ['tenant', 'config', 'remoteConfig']) {
    assert.ok(operatorKeys.has(key), `expected ${key} to be operator-owned`);
  }
  for (const tool of listCommandTools()) {
    const properties = tool.inputSchema.properties ?? {};
    const advertised = [...operatorKeys].filter((key) => Object.hasOwn(properties, key));
    assert.deepEqual(advertised, [], `${tool.name} advertises operator-owned inputs`);
  }
});
