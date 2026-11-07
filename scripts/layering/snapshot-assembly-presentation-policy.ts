// Catches: the daemon snapshot assembly presenting an iOS tree a second time, or a producer
//   adapter presenting one at all — the shape #2199 deleted. Before it, `buildSnapshotState`
//   imported the iOS snapshot engine and re-ran semantic compaction whenever a producer-name
//   branch said the engine had not, so an engine-presented Simulator bridge tree was compacted
//   twice (#2188 invariant 2, "geometric presentation occurs exactly once"). Nothing about that
//   regrowth is visible at a call site: the second pass is a legal call to a legal export, and on
//   a tree where compaction happens to be idempotent it produces no test failure at all.
// Evidence: 7ee1a5ded7 (#2233) carried provider acquisitions through one presentation owner and
//   left the bridge behind; d26b0786fb (#2329) put the bridge on the engine without retiring the
//   branch that assumed it was not; #2199 deleted the branch this policy now holds deleted.
// Cost: 739 LOC (482 rule + 257 test).
// Kill criterion: none enforced today; retire only by maintainer decision that the assembly
//   staying presentation-neutral no longer matters. An exports map cannot replace it: the engine
//   subpath is a legitimate public entrypoint for the engine's own callers, so a manifest can only
//   ban it for everyone or no one, and no manifest sees a string literal at all.

import { parseSync } from 'oxc-parser';
import { SNAPSHOT_PRODUCERS } from '@agent-device/contracts/snapshot-model';
import type { LayeringViolation, ResolvedImportEdge } from './model.ts';
import { asNode, nodeList, propertyName, visitAst, type AstNode } from './layering-ast.ts';

export const SNAPSHOT_ASSEMBLY_PRESENTATION_RULE = 'R74 snapshot-assembly-presentation-neutrality';

/**
 * The daemon assembly of a captured tree. It normalizes, prunes, annotates occlusion and attaches
 * refs; it does not present, and it does not know which channel it is holding.
 */
export const SNAPSHOT_ASSEMBLY_FILES: readonly string[] = [
  'packages/capture-kit/src/snapshot-state.ts',
  'packages/daemon/src/core/snapshot-capture.ts',
];

/** Producer adapters: they report acquisition facts and nothing else. */
export const SNAPSHOT_PRODUCER_ADAPTER_ROOTS: readonly string[] = [
  'packages/platform-apple/src/snapshot-source/',
];

/**
 * iOS presentation. The engine owns projection, geometry, scope, depth, actionability narrowing
 * and semantic compaction; the acquisition module derives the residue that decides them. Reading
 * either one from the assembly or from a producer adapter is how the deleted backend-name policy
 * grows back.
 */
const IOS_PRESENTATION_TARGETS: readonly string[] = [
  'packages/capture-kit/src/ios-snapshot-engine/',
  'packages/capture-kit/src/ios-snapshot-acquisition.ts',
];

/**
 * The iOS channel and its producers. Naming one inside the assembly is a presentation or scope
 * decision by backend name, which #2188 invariant 6 routes through typed capabilities instead.
 */
const IOS_PROVENANCE_LITERALS: ReadonlySet<string> = new Set([
  'xctest',
  ...Object.entries(SNAPSHOT_PRODUCERS)
    .filter(([, facts]) => (facts.channels as readonly string[]).includes('xctest'))
    .map(([producer]) => producer),
]);

/**
 * The producer registry and its lookup, declared by {@link PRODUCER_REGISTRY_MODULE}. The assembly
 * reads producer facts only through `snapshotRefMinting`; reading a row directly is a presentation or
 * truncation decision by producer.
 */
const PRODUCER_REGISTRY_MODULE = 'packages/contracts/src/snapshot-model.ts';
const PRODUCER_REGISTRY_EXPORTS: readonly string[] = [
  'SNAPSHOT_PRODUCERS',
  'snapshotProducerFacts',
];

export function snapshotAssemblyPresentationViolations(
  sources: ReadonlyMap<string, string>,
  edges: readonly ResolvedImportEdge[],
): LayeringViolation[] {
  return [
    ...missingOwnerViolations(sources),
    ...importViolations(edges),
    ...provenanceLiteralViolations(sources),
    ...producerRegistryReadViolations(sources, edges),
  ];
}

/**
 * A rule that silently checks nothing is worse than no rule. If the assembly moves, this fails
 * rather than passing over an empty file set.
 */
function missingOwnerViolations(sources: ReadonlyMap<string, string>): LayeringViolation[] {
  const violations: LayeringViolation[] = SNAPSHOT_ASSEMBLY_FILES.filter(
    (file) => !sources.has(file),
  ).map((file) => ({
    rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
    file,
    line: 1,
    message: `${file} is missing, so the snapshot assembly's presentation neutrality cannot be checked; point SNAPSHOT_ASSEMBLY_FILES at the assembly's new home`,
  }));
  if (!sources.has(PRODUCER_REGISTRY_MODULE)) {
    violations.push({
      rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
      file: PRODUCER_REGISTRY_MODULE,
      line: 1,
      message: `${PRODUCER_REGISTRY_MODULE} is missing, so the assembly's producer registry reads cannot be checked; point PRODUCER_REGISTRY_MODULE at the registry's new home`,
    });
  }
  return violations;
}

function importViolations(edges: readonly ResolvedImportEdge[]): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const edge of edges) {
    if (!isIosPresentationTarget(edge.target)) continue;
    if (SNAPSHOT_ASSEMBLY_FILES.includes(edge.file)) {
      violations.push({
        rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
        file: edge.file,
        line: edge.line,
        message: `the daemon snapshot assembly must not import iOS presentation (${edge.target}); an iOS capture is presented once, by the engine, before it reaches the assembly`,
      });
      continue;
    }
    if (isProducerAdapter(edge.file)) {
      violations.push({
        rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
        file: edge.file,
        line: edge.line,
        message: `a producer adapter must not import iOS presentation (${edge.target}); producers report acquisition facts and the engine presents them`,
      });
    }
  }
  return violations;
}

function provenanceLiteralViolations(sources: ReadonlyMap<string, string>): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of SNAPSHOT_ASSEMBLY_FILES) {
    const source = sources.get(file);
    if (source === undefined) continue;
    const program = parseSync(file, source).program;
    visitAst(program, (node) => {
      if (node.type !== 'Literal' || typeof node.value !== 'string') return;
      if (!IOS_PROVENANCE_LITERALS.has(node.value)) return;
      violations.push({
        rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
        file,
        line: sourceLine(source, node.start as number | undefined),
        message: `the daemon snapshot assembly must not branch on the iOS channel or producer name ('${node.value}'); producer differences enter through typed capabilities, read by the engine`,
      });
    });
  }
  return violations;
}

/**
 * What an export of a module carries from the registry: one of the registry's own exports, or a
 * namespace object of a module that exports them.
 */
type RegistryBinding =
  | Readonly<{ kind: 'registry'; name: string }>
  | Readonly<{ kind: 'namespace'; module: string }>;

/** Export name → registry binding, for the registry module and every module that re-exports it. */
type RegistryExports = ReadonlyMap<string, ReadonlyMap<string, RegistryBinding>>;

/**
 * Reads of the producer registry by resolved binding, not by spelling: a named import under any
 * alias, a default or namespace import with dotted, computed or string member access, a
 * destructured namespace, a dynamic import, and the same forms through any chain of re-exports.
 * A namespace whose use cannot be proven to miss the registry (a computed key, a namespace passed
 * on) counts as a read.
 */
function producerRegistryReadViolations(
  sources: ReadonlyMap<string, string>,
  edges: readonly ResolvedImportEdge[],
): LayeringViolation[] {
  const targets = new Map(edges.map((edge) => [`${edge.file}\0${edge.spec}`, edge.target]));
  const programs = new Map<string, AstNode>();
  const program = (file: string): AstNode | undefined => {
    const source = sources.get(file);
    if (source === undefined) return undefined;
    let parsed = programs.get(file);
    if (parsed === undefined) {
      parsed = parseSync(file, source).program as unknown as AstNode;
      programs.set(file, parsed);
    }
    return parsed;
  };
  const exports = registryExports(edges, targets, program);
  const violations: LayeringViolation[] = [];
  for (const file of SNAPSHOT_ASSEMBLY_FILES) {
    const source = sources.get(file);
    const parsed = program(file);
    if (source === undefined || parsed === undefined) continue;
    const report = (node: AstNode, message: string) =>
      violations.push({
        rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
        file,
        line: sourceLine(source, node.start as number | undefined),
        message: `the daemon snapshot assembly must not read the producer registry (${message}); producer facts reach it only through snapshotRefMinting`,
      });
    for (const [name, binding] of moduleRegistryExports(file, parsed, targets, exports)) {
      report(parsed, `it re-exports ${describeBinding(binding)} as ${name}`);
    }
    const namespaces = new Map<string, string>();
    for (const statement of nodeList(parsed.body).map(asNode)) {
      if (statement?.type !== 'ImportDeclaration') continue;
      const target = targets.get(`${file}\0${String(asNode(statement.source)?.value)}`);
      const carried = target === undefined ? undefined : exports.get(target);
      if (target === undefined || carried === undefined) continue;
      for (const specifier of nodeList(statement.specifiers).map(asNode)) {
        if (specifier === undefined) continue;
        const local = String(asNode(specifier.local)?.name);
        const imported =
          specifier.type === 'ImportSpecifier'
            ? moduleExportName(specifier.imported)
            : specifier.type === 'ImportDefaultSpecifier'
              ? 'default'
              : undefined;
        const binding =
          imported === undefined
            ? ({ kind: 'namespace', module: target } as const)
            : (carried.get(imported) ??
              (imported === 'default'
                ? ({ kind: 'namespace', module: target } as const)
                : undefined));
        if (binding?.kind === 'registry') {
          report(specifier, `${local} binds ${describeBinding(binding)}`);
        } else if (binding?.kind === 'namespace') {
          namespaces.set(local, binding.module);
        }
      }
    }
    for (const read of namespaceRegistryReads(parsed, namespaces, exports)) {
      report(read.node, read.message);
    }
  }
  for (const edge of edges) {
    if (!edge.dynamic || !SNAPSHOT_ASSEMBLY_FILES.includes(edge.file)) continue;
    const carried = exports.get(edge.target);
    if (carried === undefined) continue;
    const reads =
      edge.symbols.length === 0
        ? [`a dynamic import of ${edge.target} that names no bindings`]
        : edge.symbols.flatMap((symbol) => {
            const binding = carried.get(symbol);
            return binding ? [`a dynamic import of ${describeBinding(binding)}`] : [];
          });
    for (const read of reads) {
      violations.push({
        rule: SNAPSHOT_ASSEMBLY_PRESENTATION_RULE,
        file: edge.file,
        line: edge.line,
        message: `the daemon snapshot assembly must not read the producer registry (${read}); producer facts reach it only through snapshotRefMinting`,
      });
    }
  }
  return violations;
}

function describeBinding(binding: RegistryBinding): string {
  return binding.kind === 'registry' ? binding.name : `the namespace of ${binding.module}`;
}

function moduleExportName(node: unknown): string | undefined {
  const value = asNode(node);
  if (value?.type === 'Identifier') return String(value.name);
  return value?.type === 'Literal' && typeof value.value === 'string' ? value.value : undefined;
}

/** Follows re-exports outward from the registry module until no importer gains a binding. */
function registryExports(
  edges: readonly ResolvedImportEdge[],
  targets: ReadonlyMap<string, string>,
  program: (file: string) => AstNode | undefined,
): RegistryExports {
  const exports = new Map<string, ReadonlyMap<string, RegistryBinding>>([
    [
      PRODUCER_REGISTRY_MODULE,
      new Map(PRODUCER_REGISTRY_EXPORTS.map((name) => [name, { kind: 'registry', name } as const])),
    ],
  ]);
  const importers = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (edge.dynamic) continue;
    const files = importers.get(edge.target) ?? new Set<string>();
    files.add(edge.file);
    importers.set(edge.target, files);
  }
  const pending = [PRODUCER_REGISTRY_MODULE];
  while (pending.length > 0) {
    for (const file of importers.get(pending.pop()!) ?? []) {
      if (file === PRODUCER_REGISTRY_MODULE) continue;
      const parsed = program(file);
      if (parsed === undefined) continue;
      const carried = moduleRegistryExports(file, parsed, targets, exports);
      if (carried.size <= (exports.get(file)?.size ?? 0)) continue;
      exports.set(file, carried);
      pending.push(file);
    }
  }
  return exports;
}

/** The registry bindings one module exports, given what its imports already carry. */
function moduleRegistryExports(
  file: string,
  program: AstNode,
  targets: ReadonlyMap<string, string>,
  exports: RegistryExports,
): Map<string, RegistryBinding> {
  const carried = new Map<string, RegistryBinding>();
  const imported = new Map<string, RegistryBinding>();
  const statements = nodeList(program.body).map(asNode);
  const targetOf = (statement: AstNode) =>
    targets.get(`${file}\0${String(asNode(statement.source)?.value)}`);
  for (const statement of statements) {
    if (statement?.type !== 'ImportDeclaration') continue;
    const target = targetOf(statement);
    const from = target === undefined ? undefined : exports.get(target);
    if (target === undefined || from === undefined) continue;
    for (const specifier of nodeList(statement.specifiers).map(asNode)) {
      const local = String(asNode(specifier?.local)?.name);
      if (specifier?.type === 'ImportSpecifier') {
        const binding = from.get(moduleExportName(specifier.imported) ?? '');
        if (binding) imported.set(local, binding);
      } else if (specifier) {
        imported.set(local, { kind: 'namespace', module: target });
      }
    }
  }
  for (const statement of statements) {
    if (statement?.type === 'ExportAllDeclaration') {
      const target = targetOf(statement);
      const from = target === undefined ? undefined : exports.get(target);
      if (target === undefined || from === undefined) continue;
      const alias = moduleExportName(statement.exported);
      if (alias !== undefined) {
        carried.set(alias, { kind: 'namespace', module: target });
        continue;
      }
      for (const [name, binding] of from) if (name !== 'default') carried.set(name, binding);
      continue;
    }
    if (statement?.type === 'ExportDefaultDeclaration') {
      const declaration = asNode(statement.declaration);
      const binding =
        declaration?.type === 'Identifier' ? imported.get(String(declaration.name)) : undefined;
      if (binding) carried.set('default', binding);
      continue;
    }
    if (statement?.type !== 'ExportNamedDeclaration') continue;
    const target = statement.source ? targetOf(statement) : undefined;
    const from = target === undefined ? undefined : exports.get(target);
    if (statement.source && from === undefined) continue;
    for (const specifier of nodeList(statement.specifiers).map(asNode)) {
      const local = moduleExportName(specifier?.local) ?? '';
      const binding = from ? from.get(local) : imported.get(local);
      if (binding) carried.set(moduleExportName(specifier?.exported) ?? local, binding);
    }
  }
  return carried;
}

const TRANSPARENT_PARENTS = new Set([
  'ParenthesizedExpression',
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSNonNullExpression',
  'ChainExpression',
]);

type RegistryRead = Readonly<{ node: AstNode; message: string }>;

/**
 * Every use of a namespace binding of a registry exporter. A member read by a known name is checked
 * against what that module exports; anything else (a computed key, a destructuring rest, the
 * namespace passed or stored) cannot be proven to miss the registry, so it is a read.
 */
function namespaceRegistryReads(
  program: AstNode,
  namespaces: ReadonlyMap<string, string>,
  exports: RegistryExports,
): RegistryRead[] {
  if (namespaces.size === 0) return [];
  const reads: RegistryRead[] = [];
  const check = (node: AstNode, local: string, name: string | undefined) => {
    const module = namespaces.get(local)!;
    if (name === undefined) {
      reads.push({ node, message: `${local} is read by a computed key of ${module}` });
      return;
    }
    const binding = exports.get(module)?.get(name);
    if (binding) reads.push({ node, message: `${local}.${name} is ${describeBinding(binding)}` });
  };
  const visit = (node: unknown, ancestors: readonly [AstNode, string][]): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, ancestors);
      return;
    }
    const record = asNode(node);
    if (record === undefined || record.type === 'ImportDeclaration') return;
    if (record.type === 'Identifier' && namespaces.has(String(record.name))) {
      const local = String(record.name);
      const [parent, key] = referenceSite(ancestors);
      if (parent === undefined || isNonReferenceSlot(parent, key)) return;
      if (parent.type === 'MemberExpression' && key === 'object') {
        check(parent, local, staticMemberName(parent));
      } else if (parent.type === 'TSQualifiedName' && key === 'left') {
        check(parent, local, moduleExportName(parent.right));
      } else if (
        parent.type === 'VariableDeclarator' &&
        key === 'init' &&
        asNode(parent.id)?.type === 'ObjectPattern'
      ) {
        for (const property of nodeList(asNode(parent.id)?.properties).map(asNode)) {
          if (property?.type !== 'Property') {
            reads.push({ node: parent, message: `${local} is spread into a rest binding` });
            continue;
          }
          check(
            property,
            local,
            property.computed === true ? stringKey(property.key) : propertyName(property.key),
          );
        }
      } else {
        reads.push({ node: record, message: `${local} is used whole, so its reads are unproven` });
      }
      return;
    }
    for (const [key, child] of Object.entries(record)) {
      if (child !== null && typeof child === 'object') visit(child, [...ancestors, [record, key]]);
    }
  };
  visit(program, []);
  return reads;
}

/** The nearest ancestor that is not a parenthesis, a type assertion or an optional chain. */
function referenceSite(ancestors: readonly [AstNode, string][]): [AstNode | undefined, string] {
  for (let index = ancestors.length - 1; index >= 0; index -= 1) {
    const [parent, key] = ancestors[index]!;
    if (!TRANSPARENT_PARENTS.has(String(parent.type))) return [parent, key];
  }
  return [undefined, ''];
}

/** An identifier in a slot that names something rather than referencing the binding. */
function isNonReferenceSlot(parent: AstNode, key: string): boolean {
  if (parent.type === 'MemberExpression' && key === 'property') return parent.computed !== true;
  if (parent.type === 'TSQualifiedName' && key === 'right') return true;
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition') && key === 'key') {
    return parent.computed !== true;
  }
  return parent.type === 'PropertyDefinition' && key === 'key' && parent.computed !== true;
}

function staticMemberName(member: AstNode): string | undefined {
  return member.computed === true
    ? stringKey(member.property)
    : moduleExportName(asNode(member.property));
}

function stringKey(node: unknown): string | undefined {
  const value = asNode(node);
  if (value?.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value?.type !== 'TemplateLiteral' || nodeList(value.expressions).length > 0) return undefined;
  const cooked = asNode(asNode(nodeList(value.quasis)[0])?.value)?.cooked;
  return typeof cooked === 'string' ? cooked : undefined;
}

function isIosPresentationTarget(target: string): boolean {
  return IOS_PRESENTATION_TARGETS.some(
    (owner) => target === owner || target.startsWith(owner) || target === owner.replace(/\/$/, ''),
  );
}

function isProducerAdapter(file: string): boolean {
  return SNAPSHOT_PRODUCER_ADAPTER_ROOTS.some((root) => file.startsWith(root));
}

function sourceLine(source: string, offset: number | undefined): number {
  return source.slice(0, typeof offset === 'number' ? offset : 0).split('\n').length;
}
