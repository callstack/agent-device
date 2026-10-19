import { parseSync } from 'oxc-parser';
import { asNode, memberName, nodeList, propertyName, visitAst } from './layering-ast.ts';
import type { LayeringViolation } from './model.ts';
import { isProductionSourceFile } from './tracked-sources.ts';

export const PROCESS_GLOBALS_RULE = 'R86 process-globals';

/** Process capture and lifecycle belong to these executable or released factory boundaries. */
const PROCESS_ENTRIES = new Set([
  'src/bin.ts',
  'src/cli.ts',
  'src/daemon.ts',
  'src/agent-device-client.ts',
  'packages/capture-kit/src/png-worker.ts',
  'packages/react-native/src/companion/companion-tunnel.ts',
  'packages/react-native/src/companion/client-companion-tunnel-worker.ts',
  'packages/maestro/src/daemon-port/run-script-http-child.ts',
  // Released SDK defaults; #3759 removes these captures after agent-device/host ships (#3757).
  'src/io.ts',
  'src/sdk/host.ts',
  'src/mcp/command-tools.ts',
  'src/daemon-client/daemon-client.ts',
  'src/daemon-client/daemon-client-ensure.ts',
  'src/daemon-client/daemon-client-ensuring.ts',
]);
// src/cli/** and scripts/** are entry trees. Apple native helper executables live outside the
// TypeScript source trees. Reserve agent-device/host's entry here when #3757 supplies its path.

/** Only command execution and spawn adapters may consult the ambient command-host scope. */
const COMMAND_HOST_BOUNDARIES = new Set([
  'packages/host-kit/src/internal/exec.ts',
  'packages/platform-apple/src/core/tool-provider.ts',
  'packages/platform-linux/src/tool-provider.ts',
  'src/platform-runtime-android-adb-host.ts',
]);
const PROCESS_MEMBERS = new Set(['env', 'cwd', 'on', 'once', 'exit', 'emitWarning']);

/**
 * Catches ambient configuration and process lifecycle in reusable modules, plus command-host
 * scope reads outside spawn adapters. Uses the existing OXC layering parser; no debt baseline.
 * Test support, including packages/test-kit, uses the shared production-source classification.
 * Workers and children receive serializable configuration at their declared entry boundary.
 * Kill criterion: retire only if reusable sources may own process configuration and lifecycle.
 */
export function processGlobalsViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const [file, source] of sources) {
    if (!isProductionSourceFile(file)) continue;
    const processEntry = PROCESS_ENTRIES.has(file) || file.startsWith('src/cli/');
    const commandBoundary = COMMAND_HOST_BOUNDARIES.has(file);
    if (processEntry && commandBoundary) continue;
    const program = parseSync(file, source).program;
    const processNames = new Set(['process']);
    const processNamespaces = new Set<string>();
    const commandHostNames = new Set(['commandHostEnvironment']);
    const processExports = new Set<string>();
    visitAst(program, (node) => {
      if (node.type !== 'ImportDeclaration') return;
      const specifier = asNode(node.source)?.value;
      for (const value of nodeList(node.specifiers)) {
        const binding = asNode(value);
        const local = asNode(binding?.local)?.name;
        if (typeof local !== 'string') continue;
        if (specifier === 'node:process' || specifier === 'process') {
          if (binding?.type === 'ImportNamespaceSpecifier') processNamespaces.add(local);
          if (binding?.type !== 'ImportSpecifier' || propertyName(binding.imported) === 'default') {
            processNames.add(local);
          } else if (PROCESS_MEMBERS.has(propertyName(binding.imported) ?? '')) {
            processExports.add(local);
          }
        }
        if (propertyName(binding?.imported) === 'commandHostEnvironment') {
          commandHostNames.add(local);
        }
      }
    });
    const parents = new Map<object, Record<string, unknown>>();
    visitAst(program, (node) => {
      for (const value of Object.values(node)) {
        for (const child of Array.isArray(value) ? value : [value]) {
          const childNode = asNode(child);
          if (childNode) parents.set(childNode, node);
        }
      }
    });
    const scopes = new Set([
      'Program',
      'BlockStatement',
      'CatchClause',
      'ForStatement',
      'ForOfStatement',
      'ForInStatement',
      'FunctionDeclaration',
      'FunctionExpression',
      'ArrowFunctionExpression',
    ]);
    const bindings = new Map<object, Set<string>>();
    const bindingNodes = new Set<object>();
    const bind = (pattern: unknown, owner: Record<string, unknown> | undefined): void => {
      const node = asNode(pattern);
      if (!node || !owner) return;
      if (node.type === 'Identifier') {
        bindingNodes.add(node);
        const names = bindings.get(owner) ?? new Set<string>();
        names.add(String(node.name));
        bindings.set(owner, names);
      } else if (node.type === 'ObjectPattern') {
        for (const property of nodeList(node.properties)) {
          const item = asNode(property);
          bind(item?.type === 'RestElement' ? item.argument : item?.value, owner);
        }
      } else if (node.type === 'ArrayPattern') {
        for (const element of nodeList(node.elements)) bind(element, owner);
      } else if (node.type === 'AssignmentPattern') bind(node.left, owner);
      else if (node.type === 'RestElement') bind(node.argument, owner);
    };
    const enclosingScope = (node: Record<string, unknown>, functionOnly = false) => {
      let parent = parents.get(node);
      while (
        parent &&
        !(
          scopes.has(String(parent.type)) &&
          (!functionOnly || parent.type === 'Program' || String(parent.type).includes('Function'))
        )
      ) {
        parent = parents.get(parent);
      }
      return parent;
    };
    visitAst(program, (node) => {
      if (node.type === 'VariableDeclarator') {
        bind(node.id, enclosingScope(node, parents.get(node)?.kind === 'var'));
      } else if (String(node.type).includes('Function')) {
        for (const parameter of nodeList(node.params)) bind(parameter, node);
        bind(node.id, node.type === 'FunctionDeclaration' ? enclosingScope(node) : node);
      } else if (node.type === 'CatchClause') bind(node.param, node);
      else if (node.type === 'ClassDeclaration') bind(node.id, enclosingScope(node));
    });
    const isProcess = (value: unknown): boolean => {
      const node = asNode(value);
      if (node?.type === 'Identifier') {
        if (!processNames.has(String(node.name)) || bindingNodes.has(node)) return false;
        let child = node;
        for (let parent = parents.get(child); parent; parent = parents.get(child)) {
          if (bindings.get(parent)?.has(String(node.name))) return false;
          if (String(parent.type).startsWith('TS') && parent.expression !== child) return false;
          child = parent;
        }
        return true;
      }
      if (
        node?.type === 'MemberExpression' &&
        processNamespaces.has(String(asNode(node.object)?.name)) &&
        isProcess(node.object) &&
        memberName(node) === 'default'
      ) {
        return true;
      }
      return (
        node?.type === 'MemberExpression' &&
        asNode(node.object)?.type === 'Identifier' &&
        ['globalThis', 'global'].includes(String(asNode(node.object)?.name)) &&
        memberName(node) === 'process'
      );
    };
    visitAst(program, (node) => {
      let message: string | undefined;
      if (!processEntry) {
        const parent = parents.get(node);
        const bindingOrKey =
          parent?.type === 'ImportDefaultSpecifier' ||
          parent?.type === 'ImportNamespaceSpecifier' ||
          parent?.type === 'ImportSpecifier' ||
          (parent?.type === 'VariableDeclarator' && parent.id === node) ||
          (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed) ||
          (parent?.type === 'Property' && parent.key === node && !parent.computed) ||
          parent?.type === 'TSTypeQuery' ||
          parent?.type === 'TSTypeReference';
        const nonConfigurationMember =
          parent?.type === 'MemberExpression' &&
          parent.object === node &&
          (!parent.computed || asNode(parent.property)?.type === 'Literal') &&
          memberName(parent) !== undefined &&
          !PROCESS_MEMBERS.has(memberName(parent)!);
        if (isProcess(node) && !bindingOrKey && !nonConfigurationMember) {
          message =
            'process capture belongs at a declared process entry; pass the owning host explicitly';
        } else if (
          (node.type === 'VariableDeclarator' || node.type === 'AssignmentExpression') &&
          ['globalThis', 'global'].includes(String(asNode(node.init ?? node.right)?.name)) &&
          asNode(node.id ?? node.left)?.type === 'ObjectPattern' &&
          nodeList(asNode(node.id ?? node.left)?.properties).some(
            (value) => propertyName(asNode(value)?.key) === 'process',
          )
        ) {
          message =
            'process capture belongs at a declared process entry; pass the owning host explicitly';
        } else if (node.type === 'ImportDeclaration') {
          if (
            nodeList(node.specifiers).some((value) =>
              processExports.has(String(asNode(asNode(value)?.local)?.name)),
            )
          ) {
            message =
              'process configuration and lifecycle imports belong at a declared process entry';
          }
        }
      }
      if (!commandBoundary && node.type === 'CallExpression') {
        const callee = asNode(node.callee);
        if (
          (callee?.type === 'Identifier' && commandHostNames.has(String(callee.name))) ||
          (callee?.type === 'MemberExpression' && memberName(callee) === 'commandHostEnvironment')
        ) {
          message =
            'commandHostEnvironment() belongs at the command-execution/spawn boundary; pass the owning host explicitly';
        }
      }
      if (message) {
        violations.push({
          rule: PROCESS_GLOBALS_RULE,
          file,
          line: source.slice(0, Number(node.start ?? 0)).split('\n').length,
          message,
        });
      }
    });
  }
  return violations;
}
