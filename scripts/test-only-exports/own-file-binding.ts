import { parseSync, visitorKeys } from 'oxc-parser';

type AstNode = {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
};

type Scope = {
  parent?: Scope;
  kind: 'program' | 'function' | 'block';
  targetBinding?: 'root' | 'shadow';
};

type ScopeIndex = {
  scopeByNode: WeakMap<object, Scope>;
  declarationStarts: Set<number>;
  rootDeclaration?: AstNode;
};

const FUNCTION_TYPES = new Set([
  'ArrowFunctionExpression',
  'FunctionDeclaration',
  'FunctionExpression',
]);

const BLOCK_SCOPE_TYPES = new Set([
  'BlockStatement',
  'CatchClause',
  'ClassDeclaration',
  'ClassExpression',
  'ForInStatement',
  'ForOfStatement',
  'ForStatement',
  'StaticBlock',
  'SwitchStatement',
]);

const PROPERTY_KEY_TYPES = new Set([
  'AccessorProperty',
  'MethodDefinition',
  'Property',
  'PropertyDefinition',
]);

const MEMBER_TYPES = new Set(['MemberExpression', 'OptionalMemberExpression']);

const IMPORT_SPECIFIER_TYPES = new Set([
  'ImportDefaultSpecifier',
  'ImportNamespaceSpecifier',
  'ImportSpecifier',
]);

const DIRECT_OUTER_BINDING_TYPES = new Set([
  'ClassDeclaration',
  'FunctionDeclaration',
  'TSEnumDeclaration',
  'TSImportEqualsDeclaration',
  'TSModuleDeclaration',
]);

const NON_REFERENCE_PARENT_TYPES = new Set([
  ...IMPORT_SPECIFIER_TYPES,
  'ExportDefaultDeclaration',
  'ExportNamedDeclaration',
  'ExportSpecifier',
  'MetaProperty',
]);

const LABEL_PARENT_TYPES = new Set(['BreakStatement', 'ContinueStatement', 'LabeledStatement']);

const SINGLE_BINDING_CHILD: Readonly<Record<string, string>> = {
  AssignmentPattern: 'left',
  RestElement: 'argument',
  TSParameterProperty: 'parameter',
};

const TYPE_ONLY_KEYS = new Set([
  'implements',
  'returnType',
  'superTypeArguments',
  'superTypeParameters',
  'typeAnnotation',
  'typeArguments',
  'typeParameters',
]);

const TS_VALUE_CHILDREN: Readonly<Record<string, ReadonlySet<string>>> = {
  TSAsExpression: new Set(['expression']),
  TSEnumMember: new Set(['initializer']),
  TSExportAssignment: new Set(['expression']),
  TSInstantiationExpression: new Set(['expression']),
  TSModuleBlock: new Set(['body']),
  TSModuleDeclaration: new Set(['body']),
  TSNonNullExpression: new Set(['expression']),
  TSParameterProperty: new Set(['parameter']),
  TSSatisfiesExpression: new Set(['expression']),
};

function isAstNode(value: unknown): value is AstNode {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.type === 'string' &&
    typeof record.start === 'number' &&
    typeof record.end === 'number'
  );
}

function childNodes(node: AstNode): Array<{ key: string; node: AstNode }> {
  const children: Array<{ key: string; node: AstNode }> = [];
  for (const key of visitorKeys[node.type] ?? []) {
    const value = node[key];
    if (Array.isArray(value)) {
      for (const child of value) {
        if (isAstNode(child)) children.push({ key, node: child });
      }
    } else if (isAstNode(value)) {
      children.push({ key, node: value });
    }
  }
  return children;
}

function identifierName(node: unknown): string | undefined {
  if (!isAstNode(node) || node.type !== 'Identifier') return undefined;
  return typeof node.name === 'string' ? node.name : undefined;
}

function astNodes(value: unknown): AstNode[] {
  return Array.isArray(value) ? value.filter(isAstNode) : [];
}

function nearestFunctionScope(scope: Scope): Scope {
  let candidate: Scope | undefined = scope;
  while (candidate?.kind === 'block') candidate = candidate.parent;
  return candidate ?? scope;
}

function createChildScope(parent: Scope, kind: Scope['kind']): Scope {
  return { parent, kind };
}

function createNodeScope(node: AstNode, parent: Scope): Scope | undefined {
  if (FUNCTION_TYPES.has(node.type)) return createChildScope(parent, 'function');
  if (BLOCK_SCOPE_TYPES.has(node.type)) return createChildScope(parent, 'block');
  return undefined;
}

function bindingIdentifiers(pattern: unknown): AstNode[] {
  if (!isAstNode(pattern)) return [];
  if (pattern.type === 'Identifier') return [pattern];
  const childKey = SINGLE_BINDING_CHILD[pattern.type];
  if (childKey) return bindingIdentifiers(pattern[childKey]);
  if (pattern.type === 'ArrayPattern') {
    return astNodes(pattern.elements).flatMap(bindingIdentifiers);
  }
  if (pattern.type === 'ObjectPattern') {
    return astNodes(pattern.properties).flatMap(objectPatternBindingIdentifiers);
  }
  return [];
}

function objectPatternBindingIdentifiers(property: AstNode): AstNode[] {
  const binding = property.type === 'RestElement' ? property.argument : property.value;
  return bindingIdentifiers(binding);
}

function addBinding(
  index: ScopeIndex,
  scope: Scope,
  pattern: unknown,
  owner: AstNode,
  targetName: string,
  rootAlias = false,
): void {
  for (const identifier of bindingIdentifiers(pattern)) {
    if (identifierName(identifier) !== targetName) continue;
    index.declarationStarts.add(identifier.start);
    if (scope.kind === 'program' || rootAlias) {
      scope.targetBinding = 'root';
      if (scope.kind === 'program') index.rootDeclaration ??= owner;
    } else {
      scope.targetBinding = 'shadow';
    }
  }
}

function registerOuterBinding(
  index: ScopeIndex,
  node: AstNode,
  scope: Scope,
  targetName: string,
): void {
  if (DIRECT_OUTER_BINDING_TYPES.has(node.type)) {
    addBinding(index, scope, node.id, node, targetName);
    return;
  }
  if (node.type === 'VariableDeclaration') {
    registerVariableBindings(index, node, scope, targetName);
    return;
  }
  if (IMPORT_SPECIFIER_TYPES.has(node.type)) {
    if (node.importKind !== 'type') addBinding(index, scope, node.local, node, targetName);
  }
}

function registerVariableBindings(
  index: ScopeIndex,
  declaration: AstNode,
  scope: Scope,
  targetName: string,
): void {
  const targetScope = declaration.kind === 'var' ? nearestFunctionScope(scope) : scope;
  for (const variable of astNodes(declaration.declarations)) {
    addBinding(index, targetScope, variable.id, variable, targetName);
  }
}

function registerInnerBindings(
  index: ScopeIndex,
  node: AstNode,
  outerScope: Scope,
  nodeScope: Scope,
  targetName: string,
): void {
  if (FUNCTION_TYPES.has(node.type)) {
    if (node.type === 'FunctionExpression') {
      addBinding(index, nodeScope, node.id, node, targetName);
    }
    for (const parameter of astNodes(node.params)) {
      addBinding(index, nodeScope, parameter, node, targetName);
    }
  }
  if (node.type === 'CatchClause') {
    addBinding(index, nodeScope, node.param, node, targetName);
  }
  if (node.type === 'ClassDeclaration') {
    addBinding(index, nodeScope, node.id, node, targetName, outerScope.targetBinding === 'root');
  } else if (node.type === 'ClassExpression') {
    addBinding(index, nodeScope, node.id, node, targetName);
  }
}

function indexScopes(program: AstNode, targetName: string): ScopeIndex {
  const root: Scope = { kind: 'program' };
  const index: ScopeIndex = {
    scopeByNode: new WeakMap(),
    declarationStarts: new Set(),
  };

  function visit(node: AstNode, outerScope: Scope, isProgram = false): void {
    registerOuterBinding(index, node, outerScope, targetName);
    const scope = isProgram ? outerScope : (createNodeScope(node, outerScope) ?? outerScope);
    index.scopeByNode.set(node, scope);
    registerInnerBindings(index, node, outerScope, scope, targetName);

    for (const child of childNodes(node)) visit(child.node, scope);
  }

  visit(program, root, true);
  return index;
}

function resolvesToRootBinding(scope: Scope | undefined): boolean {
  let candidate = scope;
  while (candidate) {
    if (candidate.targetBinding) return candidate.targetBinding === 'root';
    candidate = candidate.parent;
  }
  return false;
}

function isTypePosition(parent: AstNode, key: string, alreadyInType: boolean): boolean {
  if (alreadyInType || TYPE_ONLY_KEYS.has(key)) return true;
  if (!parent.type.startsWith('TS')) return false;
  return !(TS_VALUE_CHILDREN[parent.type]?.has(key) ?? false);
}

function isReferencePosition(parent: AstNode, key: string): boolean {
  if (NON_REFERENCE_PARENT_TYPES.has(parent.type)) return false;
  if (isNonComputedName(parent, key, PROPERTY_KEY_TYPES, 'key')) return false;
  if (isNonComputedName(parent, key, MEMBER_TYPES, 'property')) return false;
  return !(LABEL_PARENT_TYPES.has(parent.type) && key === 'label');
}

function isNonComputedName(
  parent: AstNode,
  key: string,
  parentTypes: ReadonlySet<string>,
  nameKey: string,
): boolean {
  return parentTypes.has(parent.type) && key === nameKey && parent.computed !== true;
}

function exportedLocalName(
  module: ReturnType<typeof parseSync>['module'],
  exportName: string,
): string | undefined {
  for (const declaration of module.staticExports) {
    for (const entry of declaration.entries) {
      if (
        entry.exportName.name === exportName &&
        entry.moduleRequest === null &&
        entry.localName.name
      ) {
        return entry.localName.name;
      }
    }
  }
  return undefined;
}

// Counts value references to the local binding behind an export, excluding
// its own declaration, property/type names, and references resolved to a
// shadowing declaration. Returns undefined when the file does not parse.
export function countOwnFileBindingReferences(
  filePath: string,
  source: string,
  exportName: string,
): number | undefined {
  const result = parseSync(filePath, source);
  if (result.errors.length > 0) return undefined;
  const localName = exportedLocalName(result.module, exportName);
  if (!localName || !isAstNode(result.program)) return 0;

  const index = indexScopes(result.program, localName);
  const references = new Set<number>();

  function isRootBindingReference(
    node: AstNode,
    parent: AstNode | undefined,
    key: string,
    inTypePosition: boolean,
  ): boolean {
    if (node.type !== 'Identifier' || identifierName(node) !== localName) return false;
    if (!parent || inTypePosition || isInsideRootDeclaration(node, index.rootDeclaration)) {
      return false;
    }
    if (index.declarationStarts.has(node.start) || !isReferencePosition(parent, key)) return false;
    return resolvesToRootBinding(index.scopeByNode.get(node));
  }

  function visit(
    node: AstNode,
    parent: AstNode | undefined,
    key: string,
    inTypePosition: boolean,
  ): void {
    if (isRootBindingReference(node, parent, key, inTypePosition)) references.add(node.start);

    for (const child of childNodes(node)) {
      visit(child.node, node, child.key, isTypePosition(node, child.key, inTypePosition));
    }
  }

  visit(result.program, undefined, '', false);
  return references.size;
}

function isInsideRootDeclaration(node: AstNode, declaration: AstNode | undefined): boolean {
  if (!declaration) return false;
  return node.start >= declaration.start && node.end <= declaration.end;
}
