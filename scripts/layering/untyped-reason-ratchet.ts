// R89: a reason PUBLISHED ON THE WIRE may not be a new untyped literal. A published reason is the
// `reason` property inside the arguments of an error construction whose class publishes `details`:
// `new AppError(...)` (or its imported alias), `new <SubclassOfAppError>(...)`, or the `super(...)`
// call inside such a subclass's own body (that is where SnapshotSourceError and NativeBuildError
// stamp their reason). A `reason:` property anywhere else — a typed internal union outcome, a queue
// record — is not wire vocabulary and is not measured. A value counts when the scan can resolve it
// syntactically to one or more strings: a string literal; a template literal with no substitutions;
// a cast around one of those; the branches of a conditional or logical expression; an identifier
// bound to a same-file module-scope `const` (local or exported, with any marker) resolved to its
// initializer. A value defers ONLY when it reads a declared table through a member expression
// (`MY_TABLE[code].reason`) or when the expression cannot resolve to a literal at all. Comparison
// is per file by VALUE SET against the merge-base, so turning `reason: 'old'` into
// `reason: 'brand_new'` in place fails, and moving a site between files cannot hide growth.
// This rule is a RATCHET, not a proof. A syntactic scan cannot prove closure over every expression
// that evaluates to a string, so these forms are KNOWN ESCAPES and deliberately not chased:
// (1) an identifier imported from another file — its binding lives in the other file's map, and
// chasing cross-file value flow turns the ratchet into a type checker; (2) a hoisted module-scope
// OBJECT passed or spread as the details argument (`const D = { reason: 'x' }; new AppError(…, D)`);
// (3) dynamic expressions in general (function calls, substitution templates); (4) a function-scoped
// binding (local const or parameter) — the lookup reads only the module-scope map, so a local
// `const reason = 'x'` defers, and one shadowing a module constant resolves to the MODULE
// constant's literal. Scope-aware lookup is deliberately not built. The published-reason
// docs guards in test/repo-guards/ are the other half: they keep every value a table DECLARES
// documented, so the escape paths lead either to a documented table or to review.
// Cost: this rule file plus its unit test plus the shared merge-base measurement in
// ratchet-reference.ts.

import { parseSync } from 'oxc-parser';
import { propertyName, visitAst, type AstNode } from './layering-ast.ts';
import { isProductionSourceFile } from './tracked-sources.ts';
import type { LayeringViolation } from './model.ts';

export const UNTYPED_REASON_RULE = 'R89 untyped-reason-literals';

/** One published reason written as an untyped literal, with the file and 1-based line it sits on. */
export type UntypedReasonSite = Readonly<{ file: string; line: number; value: string }>;
export type UntypedReasonLiterals = Readonly<Record<string, readonly UntypedReasonSite[]>>;

/** Every wire-published `reason` literal in the tree, grouped per file, each group sorted by line. */
export function measureUntypedReasonLiterals(
  sources: ReadonlyMap<string, string>,
): UntypedReasonLiterals {
  const parsed = new Map<string, AstNode>();
  for (const [file, source] of sources) {
    if (!isProductionSourceFile(file)) continue;
    const result = parseSync(file, source);
    if (result.errors.length > 0) {
      throw new SyntaxError(
        `Cannot scan ${file} for reason literals: ${result.errors
          .map(({ message }) => message)
          .join('; ')}`,
      );
    }
    parsed.set(file, result.program as unknown as AstNode);
  }
  const constructors = appErrorConstructors(parsed.values());
  const measured: Record<string, readonly UntypedReasonSite[]> = {};
  for (const [file, program] of parsed) {
    const sites = publishedReasonSites(file, sources.get(file)!, program, constructors);
    if (sites.length === 0) continue;
    measured[file] = [...sites].sort((left, right) => left.line - right.line);
  }
  const sorted: Record<string, readonly UntypedReasonSite[]> = {};
  for (const file of Object.keys(measured).sort()) {
    sorted[file] = measured[file]!;
  }
  return sorted;
}

export function checkUntypedReasonLiterals(
  measured: UntypedReasonLiterals,
  reference: UntypedReasonLiterals,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of Object.keys(measured).sort()) {
    const known = new Set(reference[file]?.map(({ value }) => value) ?? []);
    for (const site of measured[file]!) {
      if (known.has(site.value)) continue;
      known.add(site.value);
      violations.push({
        rule: UNTYPED_REASON_RULE,
        file,
        line: site.line,
        message:
          `${file}:${site.line} publishes reason: '${site.value}' as an untyped literal, and the ` +
          'merge-base for this file declares no such reason. Publish it from the owning typed ' +
          'table (an `as const satisfies …` declaration whose reasons the docs guards require in ' +
          'the user docs) instead of writing it at the call site.',
      });
    }
  }
  return violations;
}

/**
 * Every class name whose construction publishes `details`: AppError itself, then transitively each
 * class whose superclass is already in the set. Resolved across files to a fixed point because a
 * subclass is constructed in files that never see its declaration.
 */
function appErrorConstructors(programs: IterableIterator<AstNode>): ReadonlySet<string> {
  const parents = new Map<string, string>();
  for (const program of programs) {
    visitAst(program, (node) => {
      if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return;
      const name = propertyName(node.id);
      const parentName = propertyName(node.superClass);
      if (name !== undefined && parentName !== undefined) parents.set(name, parentName);
    });
  }
  const constructors = new Set(['AppError']);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, parent] of parents) {
      if (!constructors.has(name) && constructors.has(parent)) {
        constructors.add(name);
        grew = true;
      }
    }
  }
  return constructors;
}

function publishedReasonSites(
  file: string,
  source: string,
  program: AstNode,
  globalConstructors: ReadonlySet<string>,
): UntypedReasonSite[] {
  const constructors = fileConstructorNames(program, globalConstructors);
  const consts = moduleScopeConstInits(program);
  const sites: UntypedReasonSite[] = [];
  const record = (property: AstNode, value: string): void => {
    sites.push({
      file,
      line: source.slice(0, property.start as number).split('\n').length,
      value,
    });
  };
  const scanArguments = (args: unknown): void => {
    for (const argument of (args as AstNode[] | undefined) ?? []) {
      for (const property of publishedReasonProperties(argument)) {
        for (const value of resolveReasonValues(property.value, consts, new Set())) {
          record(property, value);
        }
      }
    }
  };
  visitAst(program, (node) => {
    if (node.type === 'NewExpression') {
      const calleeName = propertyName(node.callee);
      if (calleeName !== undefined && constructors.has(calleeName)) scanArguments(node.arguments);
      return;
    }
    if (node.type === 'ClassDeclaration' || node.type === 'ClassExpression') {
      // A subclass stamps its own published reason in its super(...) call, inside its own body.
      const parentName = propertyName(node.superClass);
      if (parentName === undefined || !constructors.has(parentName)) return;
      const body = node.body as AstNode | undefined;
      for (const element of (body?.body as AstNode[] | undefined) ?? []) {
        if (element.type !== 'MethodDefinition' || element.kind !== 'constructor') continue;
        const ctor = element.value as AstNode | undefined;
        const ctorBody = ctor?.body as AstNode | undefined;
        for (const statement of (ctorBody?.body as AstNode[] | undefined) ?? []) {
          visitAst(statement, (inner) => {
            if (
              inner.type === 'CallExpression' &&
              (inner.callee as AstNode | undefined)?.type === 'Super'
            )
              scanArguments(inner.arguments);
          });
        }
      }
    }
  });
  return sites;
}

/**
 * The constructor names visible in one file: the workspace-wide set plus, to a fixed point, every
 * LOCAL name that imports one (`import { AppError as KernelAppError }`) or declares a class
 * extending one. An alias cannot then launder a construction — or a subclass of a construction —
 * out of the scan.
 */
function fileConstructorNames(
  program: AstNode,
  globalConstructors: ReadonlySet<string>,
): ReadonlySet<string> {
  const names = new Set(globalConstructors);
  const imports: Array<[string, string]> = [];
  const subclasses: Array<[string, string]> = [];
  visitAst(program, (node) => {
    if (node.type === 'ImportDeclaration') {
      for (const specifier of (node.specifiers as AstNode[] | undefined) ?? []) {
        if (specifier.type !== 'ImportSpecifier') continue;
        const imported = propertyName(specifier.imported);
        const local = propertyName(specifier.local);
        if (imported !== undefined && local !== undefined) imports.push([imported, local]);
      }
      return;
    }
    if (node.type !== 'ClassDeclaration' && node.type !== 'ClassExpression') return;
    const name = propertyName(node.id);
    const parent = propertyName(node.superClass);
    if (name !== undefined && parent !== undefined) subclasses.push([name, parent]);
  });
  let grew = true;
  while (grew) {
    grew = false;
    for (const [imported, local] of imports) {
      if (!names.has(local) && names.has(imported)) {
        names.add(local);
        grew = true;
      }
    }
    for (const [name, parent] of subclasses) {
      if (!names.has(name) && names.has(parent)) {
        names.add(name);
        grew = true;
      }
    }
  }
  return names;
}

/**
 * Every string a `reason` expression can evaluate to, per the ratchet boundary in the header:
 * a literal and a substitution-free template resolve to themselves; a cast resolves through its
 * operand — a cast writes the literal at the call site and adds no row to any table; the branches
 * of a conditional or logical expression each contribute. An identifier resolves through a
 * same-file module-scope `const` to its initializer, whatever marker it carries: an `as const`
 * scalar still evaluates to that literal here, and a table stays invisible to this walk because
 * reading it takes a member expression. Deferral is exactly two things: a MemberExpression (a read
 * from a declared table, which the docs guards keep documented) and any expression that cannot
 * resolve to a literal at all (a call, a substitution template, an unbound — typically imported —
 * name, whose flow crosses files: a documented known escape).
 */
function resolveReasonValues(
  node: unknown,
  consts: ReadonlyMap<string, AstNode>,
  seen: Set<string>,
): string[] {
  const value = unwrapWrapper(node);
  if (value === undefined || typeof value.type !== 'string') return [];
  switch (value.type) {
    case 'Literal':
      return typeof value.value === 'string' ? [value.value] : [];
    case 'TemplateLiteral': {
      if (((value.expressions as AstNode[] | undefined)?.length ?? 0) !== 0) return [];
      const quasi = (value.quasis as AstNode[] | undefined)?.[0];
      return typeof quasi?.value === 'object'
        ? [((quasi.value as AstNode).cooked as string | undefined) ?? '']
        : [];
    }
    case 'ConditionalExpression':
      return [
        ...resolveReasonValues(value.consequent, consts, seen),
        ...resolveReasonValues(value.alternate, consts, seen),
      ];
    case 'LogicalExpression':
      return [
        ...resolveReasonValues(value.left, consts, seen),
        ...resolveReasonValues(value.right, consts, seen),
      ];
    case 'Identifier': {
      const name = value.name as string;
      if (seen.has(name)) return [];
      const init = consts.get(name);
      if (init === undefined) return [];
      seen.add(name);
      return resolveReasonValues(init, consts, seen);
    }
    default:
      return [];
  }
}

/** Module-scope `const` name to initializer, local or exported, any marker. */
function moduleScopeConstInits(program: AstNode): ReadonlyMap<string, AstNode> {
  const bindings = new Map<string, AstNode>();
  for (const statement of program.body as AstNode[]) {
    // An `export const` is an ExportNamedDeclaration WRAPPING the VariableDeclaration: unwrapping
    // it is what stops `export` alone from laundering a hoisted literal out of the measurement.
    const declaration =
      statement.type === 'ExportNamedDeclaration'
        ? (statement.declaration as AstNode | undefined)
        : statement;
    if (declaration?.type !== 'VariableDeclaration' || declaration.kind !== 'const') continue;
    for (const declarator of declaration.declarations as AstNode[]) {
      const name = propertyName(declarator.id);
      const init = declarator.init as AstNode | undefined;
      if (name !== undefined && init != null) bindings.set(name, init);
    }
  }
  return bindings;
}

/**
 * The `reason` properties one construction argument publishes: the details object's OWN
 * properties, reached through the wrappers a details literal actually uses — a cast, parentheses,
 * a spread element, or a conditional/logical expression contributing extra properties (the
 * `...(cond ? { reason: 'x' } : {})` idiom the subclass stamps use). A `reason` sitting under any
 * OTHER property (`cause: { reason: 'internal' }`) is not `error.details.reason`: it never reaches
 * the wire under that key, and counting it would send the author to publish an unrelated value.
 * A details object HOISTED to a module-scope const (`new AppError('X','m', D)`) is a documented
 * known escape, not chased.
 */
function publishedReasonProperties(node: unknown): AstNode[] {
  const current = unwrapWrapper(node);
  if (current === undefined) return [];
  if (current.type === 'ObjectExpression') {
    return (current.properties as AstNode[]).flatMap(publishedReasonFromProperty);
  }
  if (current.type === 'SpreadElement') return publishedReasonProperties(current.argument);
  if (current.type === 'ConditionalExpression') {
    return [
      ...publishedReasonProperties(current.consequent),
      ...publishedReasonProperties(current.alternate),
    ];
  }
  if (current.type === 'LogicalExpression') {
    return [
      ...publishedReasonProperties(current.left),
      ...publishedReasonProperties(current.right),
    ];
  }
  return [];
}

function publishedReasonFromProperty(property: AstNode): AstNode[] {
  if (property.type === 'SpreadElement') return publishedReasonProperties(property.argument);
  if (property.type !== 'Property' || property.computed === true) return [];
  return propertyName(property.key) === 'reason' ? [property] : [];
}

function unwrapWrapper(node: unknown): AstNode | undefined {
  let current = node as AstNode | undefined;
  while (
    current != null &&
    typeof current === 'object' &&
    typeof current.type === 'string' &&
    WRAPPER_TYPES.has(current.type)
  ) {
    current = current.expression as AstNode | undefined;
  }
  return current != null && typeof current === 'object' ? current : undefined;
}

const WRAPPER_TYPES = new Set([
  'TSAsExpression',
  'TSSatisfiesExpression',
  'TSTypeAssertion',
  'ParenthesizedExpression',
  'ChainExpression',
]);
