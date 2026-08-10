// The Vitest project universe, read out of vitest.config.ts as structure rather than imported.
//
// The gate needs the list of projects to answer "does any lane run this project?", and a new
// project must fail the manifest until a lane owns it. Two ways to get the list:
//
//   1. `await import('vitest.config.ts')` — accurate, but it pulls Vite into a gate whose whole
//      point is to keep working when the test stack is broken, and it executes config code
//      (reporter construction, env reads) for a question that is purely textual.
//   2. Parse the file.
//
// This takes (2), the same choice scripts/layering/bin-alias-fast-path.ts makes for bin.ts, and
// for the same reason: the fact needed is structural, so read it structurally. A regex over
// `name:` would also match the coverage/reporters blocks and any nested option called `name`,
// so this walks the AST and only collects `name` properties inside the `projects` array.

import { parseSync } from 'oxc-parser';

type Node = { type?: string; [key: string]: unknown };

function isNode(value: unknown): value is Node {
  return value !== null && typeof value === 'object';
}

function children(node: Node): Node[] {
  return Object.entries(node).flatMap(([key, value]) => {
    if (key === 'type') return [];
    if (Array.isArray(value)) return value.filter(isNode);
    return isNode(value) ? [value] : [];
  });
}

/** The static key of an object property, whether written bare or quoted. */
function propertyKey(node: Node): string | null {
  if (node.type !== 'Property' && node.type !== 'ObjectProperty') return null;
  const key = node['key'];
  if (!isNode(key)) return null;
  if (key.type === 'Identifier' && typeof key['name'] === 'string') return key['name'];
  if (typeof key['value'] === 'string') return key['value'];
  return null;
}

function stringValue(node: Node): string | null {
  const value = node['value'];
  if (!isNode(value)) return null;
  return typeof value['value'] === 'string' ? value['value'] : null;
}

function findFirst(node: Node, predicate: (candidate: Node) => boolean): Node | null {
  if (predicate(node)) return node;
  for (const child of children(node)) {
    const found = findFirst(child, predicate);
    if (found) return found;
  }
  return null;
}

function collect(node: Node, visit: (candidate: Node) => void): void {
  visit(node);
  for (const child of children(node)) collect(child, visit);
}

/**
 * Every Vitest project name declared in `source`. Throws when the `projects` array cannot be
 * found: an empty list would silently mean "no projects to own", which is the failure mode this
 * whole module exists to prevent.
 */
export function vitestProjectNames(file: string, source: string): string[] {
  const program = parseSync(file, source).program as unknown as Node;
  const projects = findFirst(
    program,
    (node) =>
      propertyKey(node) === 'projects' &&
      isNode(node['value']) &&
      (node['value'] as Node).type === 'ArrayExpression',
  );
  if (!projects) {
    throw new Error(
      `Could not find a \`projects: [...]\` array in ${file}. The gate manifest reads the ` +
        `Vitest project universe from it; if the config moved, update ` +
        `scripts/gate-manifest/vitest-projects.ts to follow it.`,
    );
  }
  const names = new Set<string>();
  collect(projects['value'] as Node, (node) => {
    if (propertyKey(node) !== 'name') return;
    const value = stringValue(node);
    if (value !== null) names.add(value);
  });
  if (names.size === 0) {
    throw new Error(`Found a \`projects\` array in ${file} but no project \`name\` entries.`);
  }
  return [...names].sort();
}
