// Catches: a simctl argv that addresses a simulator without the set that holds it -- built by hand
//   (`['simctl', 'spawn', udid, ...]` into runXcrun, runCmdBackground or an `executable: 'xcrun'`
//   spec), prefixed by hand (`'--set'`), forged through a cast to `ScopedSimctlArgs` or
//   `SimulatorAddress`, or scoped through the set-scope builder with the set written out as
//   `undefined`. Every form type-checks where the brand does not reach (plain argv executors) or
//   where the set-scope builder accepts an explicit `undefined`, and every form runs against the
//   default CoreSimulator set: `Invalid device` for a simulator in a scoped set, or a different
//   simulator with the same udid.
// Evidence: #2784 (fixed by #2818): the AX snapshot bridge (`snapshot-source/host.ts`) and the
//   fold HID helper (`foldable/simulator-hid.ts`) built `['simctl', 'spawn', udid, ...]` from a
//   bare udid and lost the set; #2824 moved every call site onto `core/simctl.ts` and checked it
//   with a manual `git grep "'--set'"`, which this rule turns into a gate.
// Cost: 271 LOC (128 rule + 143 test).
// Kill criterion: none enforced today; retire only by maintainer decision that scoped simulator
//   sets (`--ios-simulator-device-set`) are no longer supported, or when every simctl executor
//   takes an argv type that only `core/simctl.ts` can mint.

import { parseSync } from 'oxc-parser';
import { visitAst } from './layering-ast.ts';
import type { LayeringViolation } from './model.ts';

type AstNode = Record<string, unknown>;

const RULE = 'R79 apple-simulator-scope';

const APPLE_SRC = 'packages/platform-apple/src/';
const SIMCTL_OWNER = `${APPLE_SRC}core/simctl.ts`;
const TOOL_PROVIDER = `${APPLE_SRC}core/tool-provider.ts`;
const ARGV_OWNERS = new Set([SIMCTL_OWNER, TOOL_PROVIDER]);
/** The owners whose simctl calls name no device, so they take set scope. */
const SET_SCOPE_OWNERS = new Set([
  SIMCTL_OWNER,
  `${APPLE_SRC}simulator-inventory.ts`,
  `${APPLE_SRC}logs/doctor.ts`,
]);
const SET_SCOPE_BUILDER = 'scopeSimctlArgs';

const ARGV_MESSAGE =
  'builds or forges simctl argv outside core/simctl.ts; use scopeSimctlArgsForDevice/runSimctlForDevice ' +
  'or a SimulatorAddress from simulatorAddressFor(device)';
const SET_SCOPE_MESSAGE =
  'set-scope simctl builder outside its owners; a call that names a udid takes its set from the ' +
  'device (scopeSimctlArgsForDevice) or its SimulatorAddress';

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
    const reported = new Set<string>();
    const report = (node: AstNode, message: string) => {
      const offset = Number(node.start ?? 0);
      if (reported.has(`${offset}:${message}`)) return;
      reported.add(`${offset}:${message}`);
      violations.push({ rule: RULE, file, line: lineAt(source, offset), message });
    };
    visitAst(parseSync(file, source).program, (node) => {
      if (
        !ARGV_OWNERS.has(file) &&
        node.type === 'ArrayExpression' &&
        isStringLiteral((node.elements as unknown[])[0], 'simctl')
      ) {
        report(node, ARGV_MESSAGE);
      }
      if (file.startsWith(APPLE_SRC) && file !== SIMCTL_OWNER && isStringLiteral(node, '--set')) {
        report(node, ARGV_MESSAGE);
      }
      if (
        (node.type === 'TSAsExpression' || node.type === 'TSTypeAssertion') &&
        forgesBrand(file, node.typeAnnotation)
      ) {
        report(node, ARGV_MESSAGE);
      }
      if (
        !SET_SCOPE_OWNERS.has(file) &&
        node.type === 'Identifier' &&
        node.name === SET_SCOPE_BUILDER
      ) {
        report(node, SET_SCOPE_MESSAGE);
      }
    });
  }
  return violations;
}

function forgesBrand(file: string, typeAnnotation: unknown): boolean {
  const names = referencedTypeNames(typeAnnotation);
  return (
    (file !== SIMCTL_OWNER && names.has('SimulatorAddress')) ||
    (!ARGV_OWNERS.has(file) && names.has('ScopedSimctlArgs'))
  );
}

function referencedTypeNames(typeAnnotation: unknown): Set<string> {
  const names = new Set<string>();
  visitAst(typeAnnotation, (node) => {
    if (node.type !== 'TSTypeReference') return;
    const typeName = node.typeName as AstNode | undefined;
    const name =
      typeName?.type === 'TSQualifiedName' ? (typeName.right as AstNode).name : typeName?.name;
    if (typeof name === 'string') names.add(name);
  });
  return names;
}

function isStringLiteral(node: unknown, value: string): boolean {
  return (
    node !== null &&
    typeof node === 'object' &&
    (node as AstNode).type === 'Literal' &&
    (node as AstNode).value === value
  );
}

function lineAt(source: string, offset: number): number {
  return source.slice(0, offset).split('\n').length;
}
