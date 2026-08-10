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

import {
  collect,
  findFirst,
  isNode,
  parseProgram,
  propertyKey,
  stringValue,
  type Node,
} from './ts-ast.ts';

/**
 * Every Vitest project name declared in `source`. Throws when the `projects` array cannot be
 * found: an empty list would silently mean "no projects to own", which is the failure mode this
 * whole module exists to prevent.
 */
export function vitestProjectNames(file: string, source: string): string[] {
  const program = parseProgram(file, source);
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
