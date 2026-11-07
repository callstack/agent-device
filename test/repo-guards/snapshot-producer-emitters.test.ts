import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'vitest';
import { parseSync } from 'oxc-parser';
import { REPO_ROOT } from '@agent-device/test-kit';
import { SNAPSHOT_PRODUCERS } from '@agent-device/contracts/snapshot-model';
import { visitAst, type AstNode } from '../../scripts/layering/layering-ast.ts';
import { resolveImportEdges } from '../../scripts/layering/model.ts';
import { workspaceSpecifierTargets } from '../../scripts/layering/package-boundaries.ts';
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
 * A producer is emitted only where production code publishes a capture with that identity:
 *
 * 1. the identity argument (the second) of a `stampSnapshotIdentity` call;
 * 2. the input argument (the first) of a `createIosSnapshotAcquisition` call;
 * 3. an object literal that carries `producer` beside the capture itself: `nodes` (an acquisition or
 *    a served result), `payload` (a presented iOS input) or `backend` (a provenance pair).
 *
 * The producer value is a string literal, or a `const` bound to one in the same module or imported
 * by name from another module. A forwarded value (`acquired.acquisition.producer`) originates at an
 * emitter elsewhere and is not counted again.
 *
 * A `producer` outside these sites is not a capture: diagnostic data (an `emitDiagnostic` payload, a
 * `withDiagnosticTimer` attribute), a `fallback-source` residue and a comparison identity carry no
 * tree and no provenance pair, so they name a producer without publishing one. That is a property of
 * the shape, not of a `kind` tag: a tagged object that carries the capture is an emitter. A constant
 * alone is not an emitter either; only its use at a publish site is.
 *
 * {@link FABRICATED_CAPTURE_MODULES} build an acquisition from fixture nodes to drive the engine and
 * read no device, so their capture-shaped objects publish nothing.
 *
 * Every resolvable producer reference must still be listed, at a publish site or not: an unlisted
 * name anywhere is a producer that every derived fact misses. Fallow keeps unreachable production
 * files out of the tree, so a production emitter is a reachable one.
 */

type Emission = Readonly<{ file: string; line: number; producer: string }>;
type ProducerScan = Readonly<{ emissions: Emission[]; references: Emission[] }>;

const STAMP_CALLS: Readonly<Record<string, number>> = {
  stampSnapshotIdentity: 1,
  createIosSnapshotAcquisition: 0,
};
const CAPTURE_PROPERTIES: ReadonlySet<string> = new Set(['nodes', 'payload', 'backend']);
/**
 * The engine conformance harness feeds fixture trees through the TypeScript engine to compare it
 * with the Swift presenter (`ios-snapshot-engine/replay.ts` replays one case from the command line).
 */
const FABRICATED_CAPTURE_MODULES: ReadonlySet<string> = new Set([
  'packages/capture-kit/src/ios-snapshot-engine/conformance-harness.ts',
]);

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

function lineAt(source: string, offset: unknown): number {
  return source.slice(0, typeof offset === 'number' ? offset : 0).split('\n').length;
}

function objectProperties(node: unknown): AstNode[] {
  const value = unwrapped(node);
  if (value?.type !== 'ObjectExpression') return [];
  return (value.properties as AstNode[]).filter((property) => property.type === 'Property');
}

/** Top-level `const NAME = '<string>'` bindings, which another module can import by name. */
function moduleConstants(program: AstNode): Map<string, string> {
  const constants = new Map<string, string>();
  for (const statement of program.body as AstNode[]) {
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? (statement.declaration as AstNode | null)
        : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const declarator of declaration.declarations as AstNode[]) {
      const id = declarator.id as AstNode;
      const value = stringLiteral(declarator.init);
      if (id.type === 'Identifier' && value !== undefined) constants.set(String(id.name), value);
    }
  }
  return constants;
}

type ParsedModule = Readonly<{
  source: string;
  program: AstNode;
  constants: Map<string, string>;
  /** Local name → the imported module and name, for named value imports. */
  imports: Map<string, Readonly<{ target: string; name: string }>>;
  /** Local name → the stamp it calls, for named imports of a stamp under any alias. */
  stamps: Map<string, number>;
}>;

function parseModules(sources: ReadonlyMap<string, string>): Map<string, ParsedModule> {
  const targets = new Map<string, string>();
  for (const edge of resolveImportEdges(sources, workspaceSpecifierTargets(REPO_ROOT))) {
    targets.set(`${edge.file}\0${edge.spec}`, edge.target);
  }
  const modules = new Map<string, ParsedModule>();
  for (const [file, source] of sources) {
    const program = parseSync(file, source).program as unknown as AstNode;
    const imports = new Map<string, Readonly<{ target: string; name: string }>>();
    const stamps = new Map(Object.entries(STAMP_CALLS));
    for (const statement of program.body as AstNode[]) {
      if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type') continue;
      const target = targets.get(`${file}\0${String((statement.source as AstNode).value)}`);
      for (const specifier of statement.specifiers as AstNode[]) {
        if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type') continue;
        const imported = keyName({ key: specifier.imported });
        const local = String((specifier.local as AstNode).name);
        if (imported === undefined) continue;
        const stampArgument = STAMP_CALLS[imported];
        if (stampArgument !== undefined) stamps.set(local, stampArgument);
        if (target !== undefined) imports.set(local, { target, name: imported });
      }
    }
    modules.set(file, { source, program, constants: moduleConstants(program), imports, stamps });
  }
  return modules;
}

function producerValue(
  node: unknown,
  module: ParsedModule,
  modules: ReadonlyMap<string, ParsedModule>,
): string | undefined {
  const literal = stringLiteral(node);
  if (literal !== undefined) return literal;
  const value = unwrapped(node);
  if (value?.type !== 'Identifier') return undefined;
  const name = String(value.name);
  const local = module.constants.get(name);
  if (local !== undefined) return local;
  const imported = module.imports.get(name);
  return imported && modules.get(imported.target)?.constants.get(imported.name);
}

function stampArgument(callee: unknown, module: ParsedModule): number | undefined {
  const node = unwrapped(callee);
  if (node?.type === 'Identifier') return module.stamps.get(String(node.name));
  if (node?.type !== 'MemberExpression') return undefined;
  const property = node.property as AstNode;
  const name =
    node.computed === true
      ? stringLiteral(property)
      : property.type === 'Identifier'
        ? String(property.name)
        : undefined;
  return name === undefined ? undefined : STAMP_CALLS[name];
}

function scanModule(
  file: string,
  module: ParsedModule,
  modules: ReadonlyMap<string, ParsedModule>,
): ProducerScan {
  const emissions: Emission[] = [];
  const references: Emission[] = [];
  const record = (into: Emission[], node: AstNode, producer: string | undefined) => {
    if (producer !== undefined) {
      into.push({ file, line: lineAt(module.source, node.start), producer });
    }
  };
  const publishedObjects = new Set<AstNode>();
  visitAst(module.program, (node) => {
    if (node.type !== 'CallExpression') return;
    const index = stampArgument(node.callee, module);
    if (index === undefined) return;
    const argument = unwrapped((node.arguments as unknown[])[index]);
    if (argument?.type === 'ObjectExpression') publishedObjects.add(argument);
  });
  visitAst(module.program, (node) => {
    if (node.type === 'VariableDeclarator') {
      const id = node.id as AstNode | undefined;
      if (id?.type === 'Identifier' && String(id.name).endsWith('_PRODUCER')) {
        record(references, node, stringLiteral(node.init));
      }
      return;
    }
    if (node.type !== 'ObjectExpression') return;
    const properties = objectProperties(node);
    const producer = properties.find((property) => keyName(property) === 'producer');
    if (producer === undefined) return;
    const value = producerValue(producer.value, module, modules);
    record(references, producer, value);
    const carriesCapture = properties.some((property) =>
      CAPTURE_PROPERTIES.has(keyName(property) ?? ''),
    );
    if (FABRICATED_CAPTURE_MODULES.has(file)) return;
    if (publishedObjects.has(node) || carriesCapture) record(emissions, producer, value);
  });
  return { emissions, references };
}

function producerEmitterViolations(
  registry: readonly string[],
  sources: ReadonlyMap<string, string>,
): string[] {
  const modules = parseModules(sources);
  const scans = [...modules].map(([file, module]) => scanModule(file, module, modules));
  const listed = new Set(registry);
  const emitted = new Set(scans.flatMap(({ emissions }) => emissions.map((e) => e.producer)));
  const unlisted = new Map<string, Emission>();
  for (const reference of scans.flatMap(({ references }) => references)) {
    if (listed.has(reference.producer)) continue;
    unlisted.set(`${reference.file}:${reference.line}`, reference);
  }
  return [
    ...registry
      .filter((producer) => !emitted.has(producer))
      .map((producer) => `registry producer '${producer}' has no production emitter`),
    ...[...unlisted.values()].map(
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

function withFiles(base: ReadonlyMap<string, string>, files: Record<string, string[]>) {
  return new Map([
    ...base,
    ...Object.entries(files).map(([file, lines]) => [file, lines.join('\n')] as const),
  ]);
}

const REGISTRY = Object.keys(SNAPSHOT_PRODUCERS);
const EXAMPLE_SOURCE = 'packages/platform-example/src/snapshot-source.ts';
const EXAMPLE_CAPTURE = 'packages/platform-example/src/snapshot.ts';
const EXAMPLE_CONSTANT = [
  "export const EXAMPLE_PRODUCER = 'example-tree' as const;",
  'export function prepare(host: { emitDiagnostic(input: unknown): void }) {',
  "  host.emitDiagnostic({ level: 'debug', data: { producer: EXAMPLE_PRODUCER } });",
  '}',
  '',
];

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

test('a producer constant that only feeds diagnostics is not an emitter', () => {
  const sources = withFiles(new Map(), {
    [EXAMPLE_SOURCE]: EXAMPLE_CONSTANT,
    [EXAMPLE_CAPTURE]: [
      "import { EXAMPLE_PRODUCER } from './snapshot-source.ts';",
      'export function present(host: { withDiagnosticTimer(...input: unknown[]): unknown }) {',
      "  return host.withDiagnosticTimer('present', () => undefined, { producer: EXAMPLE_PRODUCER });",
      '}',
      '',
    ],
  });
  assert.deepEqual(producerEmitterViolations(['example-tree'], sources), [
    "registry producer 'example-tree' has no production emitter",
  ]);
});

test('an imported producer constant at a stamp call is an emitter', () => {
  const sources = withFiles(new Map(), {
    [EXAMPLE_SOURCE]: EXAMPLE_CONSTANT,
    [EXAMPLE_CAPTURE]: [
      "import { stampSnapshotIdentity as stamp } from '@agent-device/contracts/snapshot';",
      "import { EXAMPLE_PRODUCER } from './snapshot-source.ts';",
      'export const capture = (result: object) =>',
      "  stamp(result, { backend: 'android', producer: EXAMPLE_PRODUCER });",
      '',
    ],
  });
  assert.deepEqual(producerEmitterViolations(['example-tree'], sources), []);
});

test('the Simulator bridge row fails when its constant survives but its capture emission does not', () => {
  const file = 'packages/platform-apple/src/snapshot-source/bridge-source.ts';
  const sources = productionSources();
  const source = sources.get(file) ?? '';
  const emission = /\n\s*producer: SNAPSHOT_BRIDGE_PRODUCER,(?=\n\s*nodes,)/;
  assert.match(
    source,
    emission,
    `${file} no longer publishes the bridge capture this control cuts`,
  );
  sources.set(file, source.replace(emission, ''));
  assert.match(sources.get(file) ?? '', /export const SNAPSHOT_BRIDGE_PRODUCER = /);
  assert.deepEqual(producerEmitterViolations(REGISTRY, sources), [
    "registry producer 'simulator-ax-bridge' has no production emitter",
  ]);
});

test('a kind-tagged object that carries the capture is an emitter, and is checked against the registry', () => {
  const tagged = (producer: string) =>
    withFiles(new Map(), {
      [EXAMPLE_CAPTURE]: [
        'export const acquire = (nodes: unknown[]) =>',
        `  ({ kind: 'acquired', producer: '${producer}', nodes });`,
        '',
      ],
    });
  assert.deepEqual(producerEmitterViolations(['example-tree'], tagged('example-tree')), []);
  assert.deepEqual(producerEmitterViolations(['example-tree'], tagged('unlisted-tree')), [
    "registry producer 'example-tree' has no production emitter",
    `${EXAMPLE_CAPTURE}:2 emits 'unlisted-tree', which SNAPSHOT_PRODUCERS does not list`,
  ]);
});

test('an unlisted producer in a residue is reported even though the residue publishes nothing', () => {
  const sources = withFiles(new Map(), {
    [EXAMPLE_CAPTURE]: [
      "export const residue = { kind: 'fallback-source', producer: 'unlisted-tree' };",
      '',
    ],
  });
  assert.deepEqual(producerEmitterViolations([], sources), [
    `${EXAMPLE_CAPTURE}:1 emits 'unlisted-tree', which SNAPSHOT_PRODUCERS does not list`,
  ]);
});
