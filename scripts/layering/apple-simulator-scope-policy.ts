// Catches: the simctl scope bypasses `tsc` cannot reject. `runXcrun` accepts only a
//   `ScopedSimctlCommand` or a named non-simctl tool, but the plain executors (`runCmd`,
//   `runCmdBackground`, an `executable: 'xcrun'` spec) take any string argv, so every simctl argv
//   reaching them must be builder output. (1) An array whose tool names simctl (the literal, a
//   quasi-only template, or a same-file binding of either; the first element, or any element
//   after leading xcrun options such as `--sdk`) outside the brand mints, however it later
//   travels: inline, held in a variable, aliased or spread. (2) At an xcrun
//   invocation, an inline argv whose tool is not a string literal other than `simctl`. (3) A cast
//   to `ScopedSimctlArgs`, `ScopedSimctlCommand` or `SimulatorAddress` outside the brand mints.
//   Every form runs against the default CoreSimulator set: `Invalid device` for a simulator in a
//   scoped set, or a different simulator with the same udid.
// Evidence: #2784 (fixed by #2818): the AX snapshot bridge (`snapshot-source/host.ts`) and the
//   fold HID helper (`foldable/simulator-hid.ts`) built `['simctl', 'spawn', udid, ...]` from a
//   bare udid and lost the set; #2824 moved every call site onto `core/simctl.ts` and checked it
//   with a manual `git grep "'--set'"`.
// Cost: 311 LOC (167 rule + 144 test).
// Kill criterion: none enforced today; retire only by maintainer decision that scoped simulator
//   sets (`--ios-simulator-device-set`) are no longer supported, or when no production xcrun
//   executor takes a plain string argv.

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

const SIMCTL_ARGV_MESSAGE =
  'builds a simctl argv outside core/simctl.ts and core/tool-provider.ts; build it with ' +
  'buildSimctlArgsForDevice or buildSimctlArgsForAddress';
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
    const program = parseSync(file, source).program;
    const simctlBindings = simctlNameBindings(program);
    const isMint = BRAND_MINTS.has(file);
    const isSimctl = (element: AstNode | null) =>
      namesSimctl(element ?? undefined) ||
      (element?.type === 'Identifier' && simctlBindings.has(element.name));
    const buildsSimctlArgv = (array: AstNode) => {
      if (isMint) return false;
      const elements = array.elements as (AstNode | null)[];
      const [tool] = elements;
      return isSimctl(tool ?? null) || (isXcrunOption(tool) && elements.some(isSimctl));
    };
    const report = (node: AstNode, message: string) =>
      violations.push({ rule: RULE, file, line: lineAt(source, node.start), message });
    visitAst(program, (node) => {
      if (node.type === 'ArrayExpression' && buildsSimctlArgv(node)) {
        report(node, SIMCTL_ARGV_MESSAGE);
      }
      const argv = xcrunArgv(node);
      if (
        argv?.type === 'ArrayExpression' &&
        !buildsSimctlArgv(argv) &&
        !namesNonSimctlTool(argv)
      ) {
        report(argv, HAND_BUILT_MESSAGE);
      }
      if (!isMint && castsToBrand(node)) report(node, FORGED_MESSAGE);
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
  const tool = firstElement(argv);
  if (tool?.type === 'SpreadElement') return true;
  return tool?.type === 'Literal' && typeof tool.value === 'string' && tool.value !== 'simctl';
}

/** A leading `-` literal is an xcrun option (`--sdk`, `--find`), so the tool name comes later. */
function isXcrunOption(node: AstNode | null | undefined): boolean {
  return node?.type === 'Literal' && typeof node.value === 'string' && node.value.startsWith('-');
}

function firstElement(array: AstNode): AstNode | undefined {
  return (array.elements as (AstNode | null)[])[0] ?? undefined;
}

/** `'simctl'` or `` `simctl` ``, the two spellings of the tool name as a constant. */
function namesSimctl(node: AstNode | undefined): boolean {
  if (isLiteral(node, 'simctl')) return true;
  if (node?.type !== 'TemplateLiteral' || (node.expressions as unknown[]).length > 0) return false;
  const [quasi] = node.quasis as AstNode[];
  return (quasi?.value as { cooked?: string } | undefined)?.cooked === 'simctl';
}

/** Names bound anywhere in the file to a constant spelling of `simctl`, whatever their scope. */
function simctlNameBindings(program: unknown): Set<unknown> {
  const bindings = new Set<unknown>();
  visitAst(program, (node) => {
    const id = node.id as AstNode | undefined;
    if (
      node.type === 'VariableDeclarator' &&
      id?.type === 'Identifier' &&
      namesSimctl(node.init as AstNode)
    ) {
      bindings.add(id.name);
    }
  });
  return bindings;
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
