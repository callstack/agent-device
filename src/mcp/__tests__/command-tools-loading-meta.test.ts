import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveCommandFrameworkTier } from '@agent-device/command-registry/registry';
import { listCommandTools } from '../command-tools.ts';

// Claude Code defers MCP tool schemas: each tool the model needs costs a tool-search turn before
// its first call. `anthropic/alwaysLoad` sends a tool's schema in the first prompt instead, and
// `anthropic/searchHint` adds keywords to the search.
const tools = listCommandTools({ outputSchemas: false });

test("exactly the 'loop' framework tier is always loaded", () => {
  const alwaysLoaded = tools
    .filter((tool) => tool._meta['anthropic/alwaysLoad'] === true)
    .map((tool) => tool.name);
  const loopTier = tools
    .filter((tool) => resolveCommandFrameworkTier(tool.name) === 'loop')
    .map((tool) => tool.name);
  assert.deepEqual(alwaysLoaded, loopTier);
  assert.ok(alwaysLoaded.includes('press'));
});

test('every tool declares search keywords', () => {
  for (const tool of tools) {
    const hint = tool._meta['anthropic/searchHint'];
    assert.ok(hint && hint.trim().length > 0, `${tool.name} declares no searchHint`);
  }
});

test('search keywords add only words the tool name and description lack', () => {
  for (const tool of tools) {
    const text = new Set(`${tool.name} ${tool.description}`.toLowerCase().split(/[^a-z0-9]+/));
    const repeated = (tool._meta['anthropic/searchHint'] ?? '')
      .split(/\s+/)
      .filter((word) => text.has(word.toLowerCase()));
    assert.deepEqual(repeated, [], `${tool.name} searchHint repeats its text`);
  }
});

// Always-loaded schemas land in every run's first prompt, so their total size is a per-run cost.
const ALWAYS_LOADED_BUDGET_BYTES = 22 * 1024;

test('the always-loaded tools stay within their byte budget', () => {
  const bytes = Buffer.byteLength(
    JSON.stringify(tools.filter((tool) => tool._meta['anthropic/alwaysLoad'] === true)),
  );
  assert.ok(bytes <= ALWAYS_LOADED_BUDGET_BYTES, `always-loaded tools are ${bytes} bytes`);
});

test('the batch description states the step shape and example steps', () => {
  const batch = tools.find((tool) => tool.name === 'batch');
  assert.ok(batch);
  assert.match(batch.description, /array of \{command, input\} objects/);
  assert.match(batch.description, /\{"command":"press","input":\{"ref":"@e12","settle":true\}\}/);
});
