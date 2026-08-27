import { parseSync } from 'oxc-parser';
import { visitAst } from './cutover-policy-ast.ts';
import type { LayeringViolation } from './model.ts';

export const SOURCE_EXECUTION_COMPATIBILITY_RULE = 'R67 source-execution-compatibility';

/** Source-checkout TypeScript must remain executable by the repository's Node type stripper. */
export function sourceExecutionCompatibilityViolations(
  sources: ReadonlyMap<string, string>,
): LayeringViolation[] {
  const violations: LayeringViolation[] = [];
  for (const [file, source] of sources) {
    const program = parseSync(file, source).program as Record<string, unknown>;
    visitAst(program, (node) => {
      if (
        node['type'] !== 'VariableDeclaration' ||
        (node['kind'] !== 'using' && node['kind'] !== 'await using')
      ) {
        return;
      }
      const offset = typeof node['start'] === 'number' ? node['start'] : 0;
      violations.push({
        rule: SOURCE_EXECUTION_COMPATIBILITY_RULE,
        file,
        line: source.slice(0, offset).split('\n').length,
        message: `source-executed TypeScript uses unsupported ${String(node['kind'])} declaration`,
      });
    });
  }
  return violations;
}
