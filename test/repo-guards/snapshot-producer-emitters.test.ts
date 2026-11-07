import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { parseSync } from 'oxc-parser';
import { REPO_ROOT } from '@agent-device/test-kit';
import { SNAPSHOT_PRODUCERS } from '@agent-device/contracts/snapshot-model';
import { visitAst } from '../../scripts/layering/layering-ast.ts';
import {
  isProductionSourceFile,
  listTrackedProductionSources,
} from '../../scripts/layering/tracked-sources.ts';

/**
 * The producer registry (`SNAPSHOT_PRODUCERS`) and the code that emits producers must agree. A row
 * that no production code emits is a fact for a hypothetical owner; a producer name that an emitter
 * spells but the registry does not list escapes every derived fact. Types catch a typed emitter,
 * but a provider result crosses a plugin boundary as data, so only a source scan sees both sides.
 *
 * An emitter is a `producer: '<name>'` property in an object literal, or a `*_PRODUCER` constant
 * bound to a name, in a tracked production source. Residue objects (they carry a `kind`) name a
 * producer that served earlier and are not emitters. Fallow keeps unreachable production files out
 * of the tree, so a production emitter is a reachable one.
 */

type Emission = Readonly<{ file: string; line: number; producer: string }>;

function stringValue(node: unknown): string | undefined {
  let current = node as Record<string, unknown> | undefined;
  while (current?.type === 'TSAsExpression' || current?.type === 'TSSatisfiesExpression') {
    current = current.expression as Record<string, unknown> | undefined;
  }
  return current?.type === 'Literal' && typeof current.value === 'string'
    ? current.value
    : undefined;
}

function keyName(property: Record<string, unknown>): string | undefined {
  const key = property.key as Record<string, unknown> | undefined;
  if (key?.type === 'Identifier') return String(key.name);
  return key?.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
}

function lineAt(source: string, offset: unknown): number {
  return source.slice(0, typeof offset === 'number' ? offset : 0).split('\n').length;
}

function producerEmissions(file: string, source: string): Emission[] {
  const emissions: Emission[] = [];
  visitAst(parseSync(file, source).program, (node) => {
    if (node.type === 'ObjectExpression') {
      const properties = (node.properties as Record<string, unknown>[]).filter(
        (property) => property.type === 'Property',
      );
      if (properties.some((property) => keyName(property) === 'kind')) return;
      for (const property of properties) {
        if (keyName(property) !== 'producer') continue;
        const producer = stringValue(property.value);
        if (producer !== undefined) {
          emissions.push({ file, line: lineAt(source, property.start), producer });
        }
      }
      return;
    }
    if (node.type !== 'VariableDeclarator') return;
    const id = node.id as Record<string, unknown> | undefined;
    if (id?.type !== 'Identifier' || !String(id.name).endsWith('_PRODUCER')) return;
    const producer = stringValue(node.init);
    if (producer !== undefined)
      emissions.push({ file, line: lineAt(source, node.start), producer });
  });
  return emissions;
}

function producerEmitterViolations(
  registry: readonly string[],
  sources: ReadonlyMap<string, string>,
): string[] {
  const emissions = [...sources].flatMap(([file, source]) => producerEmissions(file, source));
  const listed = new Set(registry);
  const emitted = new Set(emissions.map(({ producer }) => producer));
  return [
    ...registry
      .filter((producer) => !emitted.has(producer))
      .map((producer) => `registry producer '${producer}' has no production emitter`),
    ...emissions
      .filter(({ producer }) => !listed.has(producer))
      .map(
        ({ file, line, producer }) =>
          `${file}:${line} emits '${producer}', which SNAPSHOT_PRODUCERS does not list`,
      ),
  ];
}

function productionSources(): Map<string, string> {
  return new Map(
    listTrackedProductionSources(REPO_ROOT).map((file) => [
      file,
      fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'),
    ]),
  );
}

const REGISTRY = Object.keys(SNAPSHOT_PRODUCERS);

test('every registry producer has a production emitter, and every emitter is listed', () => {
  assert.deepEqual(producerEmitterViolations(REGISTRY, productionSources()), []);
});

test('the scan fails a registry row that no production code emits', () => {
  const sources = productionSources();
  assert.deepEqual(producerEmitterViolations([...REGISTRY, 'orphan-tree'], sources), [
    "registry producer 'orphan-tree' has no production emitter",
  ]);
});

test('the scan fails an emitter that names an unlisted producer', () => {
  const file = 'packages/platform-example/src/snapshot.ts';
  const sources = new Map([
    ...productionSources(),
    [
      file,
      [
        "import { stampSnapshotIdentity } from '@agent-device/contracts/snapshot';",
        'export const capture = (nodes: unknown[]) =>',
        "  stampSnapshotIdentity({ nodes }, { backend: 'android', producer: 'example-tree' });",
        '',
      ].join('\n'),
    ],
  ]);
  assert.deepEqual(producerEmitterViolations(REGISTRY, sources), [
    `${file}:3 emits 'example-tree', which SNAPSHOT_PRODUCERS does not list`,
  ]);
});

test('test support and residue references do not count as emitters', () => {
  const sources = new Map([
    [
      'packages/platform-example/src/snapshot.test.ts',
      "export const result = { backend: 'android', producer: 'orphan-tree' };\n",
    ],
    [
      'packages/platform-example/src/route.ts',
      "export const residue = { kind: 'fallback-source', producer: 'orphan-tree' };\n",
    ],
  ]);
  const production = new Map([...sources].filter(([file]) => isProductionSourceFile(file)));
  assert.deepEqual(producerEmitterViolations(['orphan-tree'], production), [
    "registry producer 'orphan-tree' has no production emitter",
  ]);
});
