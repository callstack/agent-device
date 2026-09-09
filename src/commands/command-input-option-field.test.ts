import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test, vi } from 'vitest';
import { getFlagDefinitions, getFlagDefinitionsForKey } from './cli-grammar/flag-registry.ts';
import type { FlagDefinition, FlagKey } from './cli-grammar/flag-types.ts';
import { listCommandMetadata } from './command-metadata.ts';
import type { JsonSchema } from './command-contract.ts';
import { optionField } from './command-input.ts';

/**
 * These are planted-divergence tests, not parity tests. A parity test compares
 * two hand-written copies and can only report that they already drifted; these
 * plant a divergence in the ONE declaration and require the derived surface to
 * follow it, which a second hand-written copy could not do.
 *
 * The plant therefore has to land BEFORE the surfaces are built. Command
 * metadata — and the MCP tool schema built from it — is constructed at module
 * load, so a plant applied afterwards would only prove that `optionField` reads
 * its own argument: a command that went back to a hand-written
 * `booleanField('…')` would still pass. `buildWithPlantedOption` resets the
 * module graph, writes the divergence onto the declaration, and only then
 * imports the builders, so what these tests observe is the production
 * derivation running over the planted declaration.
 */

function declarationFor(key: FlagKey): FlagDefinition {
  const definition = getFlagDefinitionsForKey(key).find(
    (candidate) => candidate.inputDescription !== undefined,
  );
  assert.ok(definition, `expected ${key} to declare an inputDescription`);
  return definition;
}

function propertyOf(schema: JsonSchema, property: string, label: string): JsonSchema {
  const found = schema.properties?.[property];
  assert.ok(found, `expected ${label} to publish the ${property} input`);
  return found;
}

function commandProperty(command: string, property: string): JsonSchema {
  const metadata = listCommandMetadata().find((entry) => entry.name === command);
  assert.ok(metadata, `expected metadata for ${command}`);
  return propertyOf(metadata.inputSchema, property, command);
}

type PlantedSurfaces = {
  /** The command metadata table the CLI, the Node client and `explain` read. */
  commandProperty(command: string, property: string): JsonSchema;
  /** The MCP tool schema, built from that same metadata. */
  toolProperty(tool: string, property: string): JsonSchema;
};

async function buildWithPlantedOption(
  key: FlagKey,
  plant: Partial<FlagDefinition>,
): Promise<PlantedSurfaces> {
  vi.resetModules();

  // Plant first: nothing in this module graph has built a command yet.
  const registry = await import('./cli-grammar/flag-registry.ts');
  const declaration = registry
    .getFlagDefinitionsForKey(key)
    .find((candidate) => candidate.inputDescription !== undefined);
  assert.ok(declaration, `expected ${key} to declare an inputDescription`);
  Object.assign(declaration, plant);

  // Build second: importing these runs the real derivation over the planted
  // declaration. The mutation stays inside this discarded graph — the surfaces
  // imported statically above never see it.
  const { listCommandMetadata: listPlantedMetadata } = await import('./command-metadata.ts');
  const { listCommandTools } = await import('../mcp/command-tools.ts');
  const metadata = listPlantedMetadata();
  const tools = listCommandTools();

  return {
    commandProperty(command, property) {
      const entry = metadata.find((candidate) => candidate.name === command);
      assert.ok(entry, `expected metadata for ${command}`);
      return propertyOf(entry.inputSchema, property, command);
    },
    toolProperty(tool, property) {
      const entry = tools.find((candidate) => candidate.name === tool);
      assert.ok(entry, `expected an MCP tool for ${tool}`);
      return propertyOf(entry.inputSchema, property, `the ${tool} tool`);
    },
  };
}

test('the shipped surfaces publish the option declaration itself, not a second copy of it', () => {
  for (const [command, property, key] of [
    ['open', 'foreground', 'foreground'],
    ['snapshot', 'customActions', 'snapshotCustomActions'],
  ] as const) {
    const declaration = declarationFor(key);
    assert.deepEqual(commandProperty(command, property), {
      type: 'boolean',
      description: declaration.inputDescription,
    });
  }
});

test('prose planted before the build moves every surface derived from the declaration', async () => {
  const planted = 'Planted description for the derivation test.';
  const shipped = declarationFor('foreground').inputDescription;
  const surfaces = await buildWithPlantedOption('foreground', { inputDescription: planted });

  // Both surfaces were BUILT from the planted declaration. An `open` command
  // that spelled its description out by hand would publish `shipped` here.
  assert.notEqual(planted, shipped);
  assert.equal(surfaces.commandProperty('open', 'foreground').description, planted);
  assert.equal(surfaces.toolProperty('open', 'foreground').description, planted);
});

test('a value type and bounds planted before the build move the derived field shape', async () => {
  const planted = 'Planted custom-actions description for the derivation test.';
  const surfaces = await buildWithPlantedOption('snapshotCustomActions', {
    type: 'int',
    min: 1,
    max: 4,
    inputDescription: planted,
  });

  // A hand-written `booleanField('…')` cannot follow either half of this.
  assert.deepEqual(surfaces.commandProperty('snapshot', 'customActions'), {
    type: 'integer',
    description: planted,
    minimum: 1,
    maximum: 4,
  });
  assert.deepEqual(surfaces.toolProperty('snapshot', 'customActions'), {
    type: 'integer',
    description: planted,
    minimum: 1,
    maximum: 4,
  });
});

test('an option with no declared tool audience cannot be derived into a field', () => {
  // `relaunch` still declares its field by hand, so the derivation refuses it
  // rather than publishing an undescribed input.
  assert.throws(() => optionField('relaunch'), /declares no inputDescription/);
});

test('every declared tool audience is consumed by a command; none is orphaned prose', () => {
  const publishedDescriptions = new Set(
    listCommandMetadata().flatMap((metadata) =>
      Object.values(metadata.inputSchema.properties ?? {}).flatMap((schema) =>
        schema.description === undefined ? [] : [schema.description],
      ),
    ),
  );

  const orphaned = getFlagDefinitions()
    .filter(
      (definition) =>
        definition.inputDescription !== undefined &&
        !publishedDescriptions.has(definition.inputDescription),
    )
    .map((definition) => definition.key);

  assert.deepEqual(orphaned, []);
});

test('the two audiences of one option are declared side by side and stay distinct', () => {
  for (const key of ['foreground', 'snapshotCustomActions'] as const) {
    const declaration = declarationFor(key);
    assert.ok(declaration.usageDescription, `${key} must keep its --help audience`);
    assert.notEqual(
      declaration.usageDescription,
      declaration.inputDescription,
      `${key} declares two audiences; collapsing them to one string is a separate decision`,
    );
  }
});

/**
 * The public SDK option types keep their editor documentation: a `.d.ts` is
 * read in an editor, where nothing resolves a `FlagDefinition`, and this repo
 * has no step that generates those docs. That documentation is not a second
 * declaration of the option's behaviour, but it is the same sentence in a
 * second place — so it is pinned: the JSDoc on the SDK field must be the
 * option's own `inputDescription`, verbatim.
 */
const SDK_DOCUMENTED_OPTIONS = [
  { key: 'foreground', file: 'packages/contracts/src/client-app.ts', field: 'foreground' },
  {
    key: 'snapshotCustomActions',
    file: 'packages/contracts/src/client-capture.ts',
    field: 'customActions',
  },
] as const;

/** The JSDoc block immediately preceding `field?:`, unwrapped onto one line. */
function sdkFieldDocumentation(source: string, field: string): string | undefined {
  const block = new RegExp(String.raw`/\*\*((?:(?!\*/)[\s\S])*)\*/\s*${field}\?:`).exec(source);
  if (!block?.[1]) return undefined;
  return block[1]
    .split('\n')
    .map((line) => line.replace(/^\s*\*?/, '').trim())
    .join(' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

test('each documented SDK option field carries its option declaration verbatim', () => {
  for (const { key, file, field } of SDK_DOCUMENTED_OPTIONS) {
    const source = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const documented = sdkFieldDocumentation(source, field);
    assert.ok(documented, `expected ${file} to document ${field} with a JSDoc block`);
    assert.equal(
      documented,
      declarationFor(key).inputDescription,
      `${file} must document ${field} with the ${key} declaration verbatim`,
    );
  }
});
