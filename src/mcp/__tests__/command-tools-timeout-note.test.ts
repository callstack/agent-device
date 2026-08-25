import assert from 'node:assert/strict';
import { test } from 'vitest';
import { resolveCommandTimeoutPolicy } from '../../core/command-descriptor/registry.ts';
import { listCommandTools } from '../command-tools.ts';

// AS-011: the enforced client request envelopes (timeout-policy, ADR 0008)
// were invisible to MCP clients, so scanners read the surface as "no
// timeout". Every tool description now ends with the note derived from its
// command's declared policy — sourced from the registry, so the declared
// number cannot drift from the enforced one.
test('every MCP tool description declares its timeout envelope', () => {
  for (const tool of listCommandTools()) {
    const policy = resolveCommandTimeoutPolicy(tool.name);
    if (policy.envelopeMs === 'unbounded') {
      assert.match(
        tool.description,
        / Streams progress; no fixed client timeout\.$/,
        `${tool.name} must declare its unbounded envelope`,
      );
      continue;
    }
    const seconds = Math.round(policy.envelopeMs / 1000);
    const suffix =
      policy.budget.source === 'none'
        ? ` Times out after ${seconds}s.`
        : ` Times out after ${seconds}s; a caller-supplied budget extends it.`;
    assert.ok(
      tool.description.endsWith(suffix),
      `${tool.name} must end with "${suffix.trim()}" (got: …${tool.description.slice(-60)})`,
    );
  }
});

// Spot-check the envelope tiers against their known values so a silent policy
// rewrite (or a broken note) shows up as a literal diff, not just as
// registry-vs-registry agreement.
test('the declared envelopes carry the known tier values', () => {
  const descriptions = new Map(listCommandTools().map((tool) => [tool.name, tool.description]));
  assert.match(descriptions.get('devices') ?? '', / Times out after 90s\.$/);
  assert.match(descriptions.get('install') ?? '', / Times out after 180s\.$/);
});
