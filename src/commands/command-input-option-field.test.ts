import assert from 'node:assert/strict';
import { test } from 'vitest';
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
 */

function declarationFor(key: FlagKey): FlagDefinition {
  const definition = getFlagDefinitionsForKey(key).find(
    (candidate) => candidate.inputDescription !== undefined,
  );
  assert.ok(definition, `expected ${key} to declare an inputDescription`);
  return definition;
}

function commandProperty(command: string, property: string): JsonSchema {
  const metadata = listCommandMetadata().find((entry) => entry.name === command);
  assert.ok(metadata, `expected metadata for ${command}`);
  const schema = metadata.inputSchema.properties?.[property];
  assert.ok(schema, `expected ${command} to publish the ${property} input`);
  return schema;
}

function withPlantedDivergence<T>(
  definition: FlagDefinition,
  plant: Partial<FlagDefinition>,
  body: () => T,
): T {
  const original = { ...definition };
  Object.assign(definition, plant);
  try {
    return body();
  } finally {
    Object.assign(definition, original);
  }
}

test('a derived field publishes the option declaration itself, not a second copy of it', () => {
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

test('planted prose divergence moves the derived field; a hand-written copy could not', () => {
  const declaration = declarationFor('foreground');
  const published = commandProperty('open', 'foreground').description;

  const derived = withPlantedDivergence(
    declaration,
    { inputDescription: 'Planted description for the derivation test.' },
    () => optionField('foreground').schema,
  );

  assert.equal(derived.description, 'Planted description for the derivation test.');
  assert.notEqual(derived.description, published);
  assert.equal(optionField('foreground').schema.description, published);
});

test('planted value-type divergence moves the derived field shape and its bounds', () => {
  const declaration = declarationFor('snapshotCustomActions');

  const derived = withPlantedDivergence(
    declaration,
    { type: 'int', min: 1, max: 4 },
    () => optionField('snapshotCustomActions').schema,
  );

  assert.equal(derived.type, 'integer');
  assert.equal(derived.minimum, 1);
  assert.equal(derived.maximum, 4);
  assert.equal(optionField('snapshotCustomActions').schema.type, 'boolean');
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
