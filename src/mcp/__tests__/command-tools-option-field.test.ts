import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import type { FlagDefinition, FlagKey } from '@agent-device/command-registry/flag-types';
import type { JsonSchema } from '@agent-device/command-surface';

/**
 * Planted-divergence tests for the MCP half of the option declaration: the tool schema is built
 * from command metadata at module load, so the plant lands BEFORE `command-tools` is imported,
 * and the tool schema observed is the production derivation over the planted declaration. The
 * metadata half lives beside the option builder in `@agent-device/command-surface`.
 */

async function toolPropertyWithPlantedOption(
  key: FlagKey,
  plant: Partial<FlagDefinition>,
  tool: string,
  property: string,
): Promise<JsonSchema> {
  vi.resetModules();
  const registry = await import('@agent-device/command-registry/flag-registry');
  const declaration = registry
    .getFlagDefinitionsForKey(key)
    .find((candidate) => candidate.inputDescription !== undefined);
  assert.ok(declaration, `expected ${key} to declare an inputDescription`);
  Object.assign(declaration, plant);

  const { listCommandTools } = await import('../command-tools.ts');
  const entry = listCommandTools().find((candidate) => candidate.name === tool);
  assert.ok(entry, `expected an MCP tool for ${tool}`);
  const found = entry.inputSchema.properties?.[property];
  assert.ok(found, `expected the ${tool} tool to publish the ${property} input`);
  return found;
}

test('prose planted before the build moves the MCP tool schema', async () => {
  const planted = 'Planted description for the derivation test.';
  const property = await toolPropertyWithPlantedOption(
    'foreground',
    { inputDescription: planted },
    'open',
    'foreground',
  );
  assert.equal(property.description, planted);
});

test('a value type and bounds planted before the build move the MCP tool field shape', async () => {
  const planted = 'Planted custom-actions description for the derivation test.';
  const property = await toolPropertyWithPlantedOption(
    'snapshotCustomActions',
    { type: 'int', min: 1, max: 4, inputDescription: planted },
    'snapshot',
    'customActions',
  );
  assert.deepEqual(property, {
    type: 'integer',
    description: planted,
    minimum: 1,
    maximum: 4,
  });
});
