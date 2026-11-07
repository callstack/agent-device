import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { parseSync } from 'oxc-parser';
import { REPO_ROOT } from '@agent-device/test-kit';
import { SNAPSHOT_PRODUCERS } from '@agent-device/contracts/snapshot-producers';
import { visitAst, type AstNode } from '../../scripts/layering/layering-ast.ts';
import {
  isProductionSourceFile,
  listTrackedProductionSources,
} from '../../scripts/layering/tracked-sources.ts';

/**
 * The producer registry (`SNAPSHOT_PRODUCERS`) and the code that emits producers must agree. A row
 * that no production code emits is a fact for a hypothetical owner; a producer name that the
 * registry does not list escapes every derived fact.
 *
 * A producer is emitted where production code publishes a capture with that identity:
 *
 * 1. the identity argument (the second) of a `stampSnapshotIdentity` call;
 * 2. the input argument (the first) of a `createIosSnapshotAcquisition` call;
 * 3. the Simulator bridge capture: an object in {@link BRIDGE_CAPTURE_MODULE} that carries `producer`
 *    beside `nodes`.
 *
 * The producer value is a string literal or a `const` bound to one in the same module. A forwarded
 * value (`acquired.acquisition.producer`) originates at an emitter elsewhere and is not counted
 * again. A `producer` property or a `*_PRODUCER` constant outside these sites publishes nothing, but
 * its name must still be listed.
 */

type Emission = Readonly<{ file: string; line: number; producer: string }>;
type ProducerScan = Readonly<{ emissions: Emission[]; references: Emission[] }>;

const PUBLISH_CALLS: Readonly<Record<string, number>> = {
  stampSnapshotIdentity: 1,
  createIosSnapshotAcquisition: 0,
};
const BRIDGE_CAPTURE_MODULE = 'packages/platform-apple/src/snapshot-source/bridge-source.ts';

function unwrapped(node: unknown): AstNode | undefined {
  let current = node as AstNode | undefined;
  while (
    current?.type === 'TSAsExpression' ||
    current?.type === 'TSSatisfiesExpression' ||
    current?.type === 'ParenthesizedExpression'
  ) {
    current = current.expression as AstNode | undefined;
  }
  return current;
}

function stringLiteral(node: unknown): string | undefined {
  const value = unwrapped(node);
  return value?.type === 'Literal' && typeof value.value === 'string' ? value.value : undefined;
}

function keyName(property: AstNode): string | undefined {
  const key = property.key as AstNode | undefined;
  if (key?.type === 'Identifier' && property.computed !== true) return String(key.name);
  return key?.type === 'Literal' && typeof key.value === 'string' ? key.value : undefined;
}

function objectProperties(node: unknown): AstNode[] {
  const value = unwrapped(node);
  if (value?.type !== 'ObjectExpression') return [];
  return (value.properties as AstNode[]).filter((property) => property.type === 'Property');
}

/** Top-level `const NAME = '<string>'` bindings of the module. */
function moduleConstants(program: AstNode): Map<string, string> {
  const constants = new Map<string, string>();
  for (const statement of program.body as AstNode[]) {
    const declaration =
      statement.type === 'ExportNamedDeclaration' ? (statement.declaration as AstNode) : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const declarator of declaration.declarations as AstNode[]) {
      const id = declarator.id as AstNode;
      const value = stringLiteral(declarator.init);
      if (id.type === 'Identifier' && value !== undefined) constants.set(String(id.name), value);
    }
  }
  return constants;
}

function publishArgument(call: AstNode): AstNode | undefined {
  const callee = unwrapped(call.callee);
  const name =
    callee?.type === 'Identifier'
      ? String(callee.name)
      : callee?.type === 'MemberExpression' && callee.computed !== true
        ? String((callee.property as AstNode).name)
        : undefined;
  const index = name === undefined ? undefined : PUBLISH_CALLS[name];
  return index === undefined ? undefined : unwrapped((call.arguments as unknown[])[index]);
}

function scanModule(file: string, source: string): ProducerScan {
  const program = parseSync(file, source).program as unknown as AstNode;
  const constants = moduleConstants(program);
  const producerOf = (node: unknown) => {
    const value = unwrapped(node);
    return value?.type === 'Identifier' ? constants.get(String(value.name)) : stringLiteral(value);
  };
  const emissions: Emission[] = [];
  const references: Emission[] = [];
  const record = (into: Emission[], node: AstNode, producer: string | undefined) => {
    if (producer === undefined) return;
    into.push({ file, line: source.slice(0, node.start as number).split('\n').length, producer });
  };
  const published = new Set<AstNode>();
  visitAst(program, (node) => {
    if (node.type !== 'CallExpression') return;
    const argument = publishArgument(node);
    if (argument?.type === 'ObjectExpression') published.add(argument);
  });
  visitAst(program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const id = node.id as AstNode;
      if (id.type === 'Identifier' && String(id.name).endsWith('_PRODUCER')) {
        record(references, node, stringLiteral(node.init));
      }
      return;
    }
    if (node.type !== 'ObjectExpression') return;
    const properties = objectProperties(node);
    const producer = properties.find((property) => keyName(property) === 'producer');
    if (producer === undefined) return;
    const value = producerOf(producer.value);
    record(references, producer, value);
    const bridgeCapture =
      file === BRIDGE_CAPTURE_MODULE &&
      properties.some((property) => keyName(property) === 'nodes');
    if (published.has(node) || bridgeCapture) record(emissions, producer, value);
  });
  return { emissions, references };
}

function producerEmitterViolations(
  registry: readonly string[],
  sources: ReadonlyMap<string, string>,
): string[] {
  const scans = [...sources].map(([file, source]) => scanModule(file, source));
  const listed = new Set(registry);
  const emitted = new Set(scans.flatMap(({ emissions }) => emissions.map((e) => e.producer)));
  const unlisted = scans
    .flatMap(({ references }) => references)
    .filter((reference) => !listed.has(reference.producer));
  return [
    ...registry
      .filter((producer) => !emitted.has(producer))
      .map((producer) => `registry producer '${producer}' has no production emitter`),
    ...unlisted.map(
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
const EXAMPLE_CAPTURE = 'packages/platform-example/src/snapshot.ts';

function example(lines: string[]): Map<string, string> {
  return new Map([[EXAMPLE_CAPTURE, lines.join('\n')]]);
}

test('every registry producer has a production emitter, and every emitter is listed', () => {
  assert.deepEqual(producerEmitterViolations(REGISTRY, productionSources()), []);
});

test('the scan fails a registry row that no production code emits', () => {
  assert.deepEqual(producerEmitterViolations([...REGISTRY, 'orphan-tree'], productionSources()), [
    "registry producer 'orphan-tree' has no production emitter",
  ]);
});

test('the scan fails an emitter that names an unlisted producer', () => {
  const sources = new Map([
    ...productionSources(),
    ...example([
      "import { stampSnapshotIdentity } from '@agent-device/contracts/snapshot';",
      'export const capture = (nodes: unknown[]) =>',
      "  stampSnapshotIdentity({ nodes }, { backend: 'android', producer: 'example-tree' });",
      '',
    ]),
  ]);
  assert.deepEqual(producerEmitterViolations(REGISTRY, sources), [
    `${EXAMPLE_CAPTURE}:3 emits 'example-tree', which SNAPSHOT_PRODUCERS does not list`,
  ]);
});

test('a provider acquisition call emits its producer, through a same-module constant', () => {
  const sources = example([
    "const EXAMPLE_PRODUCER = 'example-tree' as const;",
    'export const acquire = (acquisition: any, nodes: unknown[]) =>',
    '  acquisition.createIosSnapshotAcquisition({ producer: EXAMPLE_PRODUCER, nodes });',
    '',
  ]);
  assert.deepEqual(producerEmitterViolations(['example-tree'], sources), []);
});

test('test support, residue and diagnostic references do not count as emitters', () => {
  const sources = new Map([
    [
      'packages/platform-example/src/snapshot.test.ts',
      "export const result = { backend: 'android', producer: 'orphan-tree' };\n",
    ],
    [
      'packages/platform-example/src/route.ts',
      "export const residue = { kind: 'fallback-source', producer: 'orphan-tree', nodes: [] };\n",
    ],
    [
      EXAMPLE_CAPTURE,
      "const ORPHAN_PRODUCER = 'orphan-tree';\nexport const report = (emit: (data: object) => void) => emit({ producer: ORPHAN_PRODUCER });\n",
    ],
  ]);
  const production = new Map([...sources].filter(([file]) => isProductionSourceFile(file)));
  assert.deepEqual(producerEmitterViolations(['orphan-tree'], production), [
    "registry producer 'orphan-tree' has no production emitter",
  ]);
});

test('the Simulator bridge row fails when its constant survives but its capture emission does not', () => {
  const sources = productionSources();
  const source = sources.get(BRIDGE_CAPTURE_MODULE) ?? '';
  const emission = /\n\s*producer: SNAPSHOT_BRIDGE_PRODUCER,(?=\n\s*nodes,)/;
  assert.match(
    source,
    emission,
    `${BRIDGE_CAPTURE_MODULE} no longer publishes the bridge capture this control cuts`,
  );
  sources.set(BRIDGE_CAPTURE_MODULE, source.replace(emission, ''));
  assert.match(
    sources.get(BRIDGE_CAPTURE_MODULE) ?? '',
    /export const SNAPSHOT_BRIDGE_PRODUCER = /,
  );
  assert.deepEqual(producerEmitterViolations(REGISTRY, sources), [
    "registry producer 'simulator-ax-bridge' has no production emitter",
  ]);
});

test('an unlisted producer in a residue is reported even though the residue publishes nothing', () => {
  const sources = example([
    "export const residue = { kind: 'fallback-source', producer: 'unlisted-tree' };",
    '',
  ]);
  assert.deepEqual(producerEmitterViolations([], sources), [
    `${EXAMPLE_CAPTURE}:1 emits 'unlisted-tree', which SNAPSHOT_PRODUCERS does not list`,
  ]);
});

test('a computed identifier key is not a producer property, but a computed string key is', () => {
  const keyed = (key: string) =>
    example([
      "const producer = 'label';",
      `export const capture = (stamp: any) => stamp.stampSnapshotIdentity({}, { ${key}: 'example-tree' });`,
      '',
    ]);
  assert.deepEqual(producerEmitterViolations(['example-tree'], keyed('[producer]')), [
    "registry producer 'example-tree' has no production emitter",
  ]);
  assert.deepEqual(producerEmitterViolations(['example-tree'], keyed("['producer']")), []);
});
