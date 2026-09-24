// Catches: the two simctl scope bypasses `tsc` cannot reject. (1) A hand-built argv at an xcrun
//   invocation: `runXcrun` accepts only a `ScopedSimctlCommand` or a named non-simctl tool, but
//   the plain executors (`runCmd('xcrun', …)`, `runCmdBackground('xcrun', …)`, an
//   `executable: 'xcrun'` spec) take any string argv, so an inline argv there must name its tool
//   as a string literal other than `simctl`. (2) A cast to `ScopedSimctlArgs`,
//   `ScopedSimctlCommand` or `SimulatorAddress` outside the modules that mint them. Either form
//   runs against the default CoreSimulator set: `Invalid device` for a simulator in a scoped set,
//   or a different simulator with the same udid.
// Evidence: #2784 (fixed by #2818): the AX snapshot bridge (`snapshot-source/host.ts`) and the
//   fold HID helper (`foldable/simulator-hid.ts`) built `['simctl', 'spawn', udid, ...]` from a
//   bare udid and lost the set; #2824 moved every call site onto `core/simctl.ts` and checked it
//   with a manual `git grep "'--set'"`.
// Cost: 225 LOC (109 rule + 116 test).
// Kill criterion: none enforced today; retire only by maintainer decision that scoped simulator
//   sets (`--ios-simulator-device-set`) are no longer supported, or when no production xcrun
//   invocation takes a plain string argv.

import { parseSync } from 'oxc-parser';
import { propertyName, visitAst } from './layering-ast.ts';
import type { LayeringViolation } from './model.ts';

type AstNode = Record<string, unknown>;

const RULE = 'R79 apple-simulator-scope';

/** The modules that mint the simulator-scope brands; a cast to a brand anywhere else forges it. */
const BRAND_MINTS = new Set([
  'packages/platform-apple/src/core/simctl.ts',
  'packages/platform-apple/src/core/tool-provider.ts',
]);
const BRANDS = new Set(['ScopedSimctlArgs', 'ScopedSimctlCommand', 'SimulatorAddress']);

const HAND_BUILT_MESSAGE =
  'hands xcrun an argv whose tool is not a literal non-simctl name; build a simctl argv with ' +
  'buildSimctlArgsForDevice or buildSimctlArgsForAddress';
const FORGED_MESSAGE =
  'forges a simulator-scope brand outside core/simctl.ts and core/tool-provider.ts; mint it ' +
  'with simulatorAddressFor, scopeSimctlArgsForDevice or buildSimctlArgsForDevice';

/** Production TypeScript under `packages/*\/src/` and `src/`; tests and fixtures are exempt. */
export function isPolicedSimulatorScopeFile(file: string): boolean {
  if (!/^packages\/[^/]+\/src\//.test(file) && !file.startsWith('src/')) return false;
  return !(
    file.endsWith('.test.ts') ||
    file.includes('/__tests__/') ||
    file.endsWith('.fixtures.ts')
  );
}

export function appleSimulatorScopeViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const [file, source] of sources) {
    if (!isPolicedSimulatorScopeFile(file)) continue;
    const report = (node: AstNode, message: string) =>
      violations.push({ rule: RULE, file, line: lineAt(source, node.start), message });
    visitAst(parseSync(file, source).program, (node) => {
      const argv = xcrunArgv(node);
      if (argv?.type === 'ArrayExpression' && !namesNonSimctlTool(argv)) {
        report(argv, HAND_BUILT_MESSAGE);
      }
      if (!BRAND_MINTS.has(file) && castsToBrand(node)) report(node, FORGED_MESSAGE);
    });
  }
  return violations;
}

/** The argv of `f('xcrun', argv, …)` or of an `{ executable: 'xcrun', args }` spec. */
function xcrunArgv(node: AstNode): AstNode | undefined {
  if (node.type === 'CallExpression') {
    const args = node.arguments as AstNode[];
    const index = args.findIndex((arg) => isLiteral(arg, 'xcrun'));
    return index >= 0 ? args[index + 1] : undefined;
  }
  if (node.type !== 'ObjectExpression') return undefined;
  const properties = node.properties as AstNode[];
  const valueOf = (key: string) =>
    properties.find((property) => propertyName(property.key) === key)?.value as AstNode | undefined;
  return isLiteral(valueOf('executable'), 'xcrun') ? valueOf('args') : undefined;
}

/** A spread passes an argv through like a variable; any other first element must name the tool. */
function namesNonSimctlTool(argv: AstNode): boolean {
  const tool = (argv.elements as AstNode[])[0];
  if (tool?.type === 'SpreadElement') return true;
  return tool?.type === 'Literal' && typeof tool.value === 'string' && tool.value !== 'simctl';
}

function castsToBrand(node: AstNode): boolean {
  if (node.type !== 'TSAsExpression' && node.type !== 'TSTypeAssertion') return false;
  let names = false;
  visitAst(node.typeAnnotation, (typeNode) => {
    if (typeNode.type !== 'TSTypeReference') return;
    const typeName = typeNode.typeName as AstNode;
    const name =
      typeName.type === 'TSQualifiedName' ? (typeName.right as AstNode).name : typeName.name;
    names ||= BRANDS.has(name as string);
  });
  return names;
}

function isLiteral(node: AstNode | undefined, value: string): boolean {
  return node?.type === 'Literal' && node.value === value;
}

function lineAt(source: string, offset: unknown): number {
  return source.slice(0, Number(offset ?? 0)).split('\n').length;
}
