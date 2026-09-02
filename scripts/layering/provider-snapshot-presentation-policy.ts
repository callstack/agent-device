import { parseSync } from 'oxc-parser';
import { type LayeringViolation } from './model.ts';
import { memberPath, propertyName, visitAst } from './layering-ast.ts';

export const PROVIDER_SNAPSHOT_PRESENTATION_RULE = 'R73 provider-snapshot-presentation-ownership';

export const WEBDRIVER_IOS_SNAPSHOT_ADAPTER =
  'packages/provider-webdriver/src/webdriver-ios-snapshot.ts';
export const LIMRUN_IOS_SNAPSHOT_ADAPTER = 'packages/provider-limrun/src/ios-snapshot-adapter.ts';
export const IOS_SNAPSHOT_PRESENTATION_OWNER = 'src/snapshot/ios-snapshot-runtime.ts';
export const SNAPSHOT_RUNTIME_HOST = 'src/snapshot/snapshot-desktop-surface.ts';

const ADAPTER_FILES = [WEBDRIVER_IOS_SNAPSHOT_ADAPTER, LIMRUN_IOS_SNAPSHOT_ADAPTER] as const;
const PRESENTATION_WIRING_FILES = [
  'packages/provider-webdriver/src/platform-runtime.ts',
  'packages/provider-limrun/src/app-log-runtime.ts',
] as const;
const FORBIDDEN_ADAPTER_IDENTIFIERS = new Set([
  'createIosSnapshotRequest',
  'deriveIosCaptureHint',
  'planIosSnapshot',
  'presentIosSnapshot',
  'publishIosSnapshot',
  'IosSnapshotEngineError',
  'toIosSnapshotEngineErrorDetails',
  'attachRefs',
  'stripRefs',
  'warningsForResidue',
]);
const ACQUIRED_CARRIER_FIELDS = [
  'producer',
  'intent',
  'nodes',
  'viewport',
  'lineage',
  'residue',
] as const;

type AstNode = Record<string, unknown>;

export function providerSnapshotPresentationViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const file of ADAPTER_FILES) {
    const source = sources.get(file);
    if (source === undefined) {
      violations.push(violation(file, `${file} is missing from the provider acquisition boundary`));
      continue;
    }
    const program = parseSync(file, source).program;
    const forbidden = new Set<string>();
    visitAst(program, (node) => {
      if (node.type === 'Identifier' && FORBIDDEN_ADAPTER_IDENTIFIERS.has(String(node.name))) {
        forbidden.add(String(node.name));
      }
      if (node.type === 'Property' && propertyName(node.key) === 'ref') {
        forbidden.add('ref');
      }
    });
    for (const identifier of [...forbidden].sort()) {
      violations.push(
        violation(
          file,
          `provider acquisition adapter contains ${identifier}; presentation, warnings, and refs belong to ${IOS_SNAPSHOT_PRESENTATION_OWNER}`,
        ),
      );
    }
    if (!hasIdentifier(program, 'SnapshotRuntimeAcquiredResult')) {
      violations.push(
        violation(file, 'provider acquisition adapter must return SnapshotRuntimeAcquiredResult'),
      );
    }
    const carriers = directAcquiredCarriers(program);
    if (carriers.length !== 1) {
      violations.push(
        violation(
          file,
          'provider acquisition adapter must directly return one acquired carrier from its boundary',
        ),
      );
    }
    const carrier = carriers[0];
    for (const field of ACQUIRED_CARRIER_FIELDS) {
      if (!carrier || propertyValueNode(carrier, field) === undefined) {
        violations.push(
          violation(file, `provider acquired carrier must preserve ${field} at the boundary`),
        );
      }
    }
    const residue = carrier && propertyValueNode(carrier, 'residue');
    if (!isResidueDerivation(residue)) {
      violations.push(
        violation(
          file,
          'provider acquired carrier residue must be the direct result of the shared derivation helper',
        ),
      );
    }
    if (hasResidueRewrite(program)) {
      violations.push(
        violation(file, 'provider acquisition adapter must not rewrite acquired carrier residue'),
      );
    }
    if (callCount(program, 'deriveIosSnapshotAcquisitionResidue') !== 1) {
      violations.push(
        violation(
          file,
          'provider acquisition adapter must derive its residue exactly once through the shared helper',
        ),
      );
    }
    if (!source.includes("stage: 'acquired'")) {
      violations.push(
        violation(file, 'provider acquisition adapter must return an acquired stage'),
      );
    }
  }

  const presentationOwner = sources.get(IOS_SNAPSHOT_PRESENTATION_OWNER);
  if (presentationOwner === undefined) {
    violations.push(
      violation(IOS_SNAPSHOT_PRESENTATION_OWNER, 'shared iOS presentation owner is missing'),
    );
  } else {
    const parsedOwner = parseSync(IOS_SNAPSHOT_PRESENTATION_OWNER, presentationOwner);
    if (callCount(parsedOwner.program, 'presentIosSnapshot') !== 1) {
      violations.push(
        violation(
          IOS_SNAPSHOT_PRESENTATION_OWNER,
          'shared iOS presentation owner must call presentIosSnapshot exactly once',
        ),
      );
    }
  }

  const host = sources.get(SNAPSHOT_RUNTIME_HOST);
  const parsedHost = host && parseSync(SNAPSHOT_RUNTIME_HOST, host);
  const eagerlyImportsPresenter = parsedHost?.module.staticImports.some((entry) =>
    entry.moduleRequest.value.endsWith('ios-snapshot-runtime.ts'),
  );
  if (
    host === undefined ||
    eagerlyImportsPresenter ||
    !host.includes("import('./ios-snapshot-runtime.ts')") ||
    !host.includes('presentIosSnapshotAcquisition')
  ) {
    violations.push(
      violation(
        SNAPSHOT_RUNTIME_HOST,
        'snapshot runtime host must lazily load and expose the shared iOS presentation owner',
      ),
    );
  }
  for (const file of PRESENTATION_WIRING_FILES) {
    if (!sources.get(file)?.includes('presentIosAcquisition')) {
      violations.push(
        violation(file, 'provider runtime must pass the host iOS presentation owner'),
      );
    }
  }
  return violations;
}

function directAcquiredCarriers(program: unknown): AstNode[] {
  const carriers: AstNode[] = [];
  visitAst(program, (node) => {
    if (node.type !== 'ExportNamedDeclaration') return;
    const declaration = node.declaration as AstNode | undefined;
    if (declaration?.type === 'FunctionDeclaration') {
      collectAcquiredCarriers(declaration.body, carriers);
      return;
    }
    if (declaration?.type !== 'VariableDeclaration') return;
    for (const declarator of (declaration.declarations as AstNode[] | undefined) ?? []) {
      const initializer = declarator.init as AstNode | undefined;
      if (initializer?.type && FUNCTION_NODES.has(initializer.type)) {
        collectAcquiredCarriers(initializer.body, carriers);
      }
    }
  });
  return carriers;
}

const FUNCTION_NODES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

function collectAcquiredCarriers(node: unknown, carriers: AstNode[]): void {
  visitFunctionBody(node, (candidate) => {
    if (candidate.type !== 'ReturnStatement') return;
    const returned = candidate.argument as AstNode | undefined;
    if (returned?.type !== 'ObjectExpression') return;
    if (!isStringLiteral(propertyValueNode(returned, 'stage'), 'acquired')) return;
    const carrier = propertyValueNode(returned, 'acquisition');
    if (carrier?.type === 'ObjectExpression') carriers.push(carrier);
  });
}

function visitFunctionBody(node: unknown, visitor: (node: AstNode) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) visitFunctionBody(child, visitor);
    return;
  }
  const record = node as AstNode;
  if (record.type && FUNCTION_NODES.has(record.type)) return;
  visitor(record);
  for (const child of Object.values(record)) visitFunctionBody(child, visitor);
}

function propertyValueNode(node: AstNode, name: string): AstNode | undefined {
  if (node.type !== 'ObjectExpression') return undefined;
  const property = (node.properties as AstNode[] | undefined)?.find(
    (candidate) => candidate.type === 'Property' && propertyName(candidate.key) === name,
  );
  return property?.value as AstNode | undefined;
}

function isResidueDerivation(node: AstNode | undefined): boolean {
  const callee = node?.callee as AstNode | undefined;
  return (
    node?.type === 'CallExpression' &&
    callee?.type === 'Identifier' &&
    callee.name === 'deriveIosSnapshotAcquisitionResidue'
  );
}

function hasResidueRewrite(program: unknown): boolean {
  let found = false;
  visitAst(program, (node) => {
    if (
      node.type === 'AssignmentExpression' &&
      memberPath(node.left as AstNode | undefined)?.includes('residue')
    ) {
      found = true;
    }
    if (
      node.type === 'CallExpression' &&
      memberPath(node.callee as AstNode | undefined)?.includes('residue')
    ) {
      found = true;
    }
  });
  return found;
}

function isStringLiteral(node: AstNode | undefined, value: string): boolean {
  return node?.type === 'Literal' && node.value === value;
}

function callCount(program: unknown, name: string): number {
  let count = 0;
  visitAst(program, (node) => {
    if (node.type !== 'CallExpression') return;
    const callee = node.callee as AstNode | undefined;
    if (callee?.type === 'Identifier' && callee.name === name) count += 1;
  });
  return count;
}

function hasIdentifier(program: unknown, name: string): boolean {
  let found = false;
  visitAst(program, (node) => {
    if (node.type === 'Identifier' && node.name === name) found = true;
  });
  return found;
}

function violation(file: string, message: string): LayeringViolation {
  return { rule: PROVIDER_SNAPSHOT_PRESENTATION_RULE, file, line: 1, message };
}
