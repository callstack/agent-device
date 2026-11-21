// Collects every published reason table: a `const` declared `as const satisfies ReasonTable<'owner'>`
// in a tracked production source, exported or not. The owner is a CLI command or a subsystem. The table type lives
// in `packages/kernel/src/errors.ts`; each table stays beside the code that classifies its failures,
// and this scan is what joins them into one vocabulary. It reads syntax only, so the scan needs no
// build and evaluates no module.

import { parseSync } from 'oxc-parser';
import { propertyName, visitAst, type AstNode } from '../layering/layering-ast.ts';
import { isProductionSourceFile } from '../layering/tracked-sources.ts';

export type CollectedReasonRow = Readonly<{
  member: string;
  reason: string;
  summary: string;
  commands: readonly string[];
}>;

export type CollectedReasonTable = Readonly<{
  file: string;
  line: number;
  name: string;
  owner: string;
  rows: readonly CollectedReasonRow[];
}>;

const TABLE_TYPE = 'ReasonTable';

/** Every reason table in `sources`, in file order, then declaration order. */
export function collectReasonTables(sources: ReadonlyMap<string, string>): CollectedReasonTable[] {
  const tables: CollectedReasonTable[] = [];
  for (const file of [...sources.keys()].sort()) {
    if (!isProductionSourceFile(file)) continue;
    const source = sources.get(file)!;
    if (!source.includes(TABLE_TYPE)) continue;
    const result = parseSync(file, source);
    if (result.errors.length > 0) {
      throw new SyntaxError(`Cannot scan ${file} for reason tables: ${result.errors[0]!.message}`);
    }
    const lineOf = (node: AstNode) => source.slice(0, node.start as number).split('\n').length;
    visitAst(result.program, (node) => {
      if (node.type !== 'VariableDeclarator') return;
      const marked = reasonTableMarker(node.init);
      if (marked === undefined) return;
      const name = propertyName(node.id) ?? '(unnamed)';
      const where = `${file}:${lineOf(node)} ${name}`;
      tables.push({
        file,
        line: lineOf(node),
        name,
        owner: marked.owner,
        rows: readRows(marked.object, where),
      });
    });
  }
  return tables;
}

/**
 * The problems that make the collected vocabulary unpublishable: a reason value two rows declare,
 * a command the CLI does not have, and a table that declares no row.
 */
export function reasonTableProblems(
  tables: readonly CollectedReasonTable[],
  cliCommands: ReadonlySet<string>,
): string[] {
  const rows = tables.flatMap((table) =>
    table.rows.map((row) => ({ ...row, owner: `${table.name}.${row.member} (${table.file})` })),
  );
  const empty = tables
    .filter((table) => table.rows.length === 0)
    .map((table) => `${table.name} (${table.file}) declares no reason.`);
  const unknownCommands = rows.flatMap((row) =>
    row.commands
      .filter((command) => !cliCommands.has(command))
      .map((command) => `${row.owner} names "${command}", which is not a CLI command.`),
  );
  const duplicates = [...new Set(rows.map((row) => row.reason))].flatMap((reason) => {
    const declared = rows.filter((row) => row.reason === reason).map((row) => row.owner);
    return declared.length > 1
      ? [`"${reason}" is declared by ${declared.join(' and ')}; keep one owner.`]
      : [];
  });
  return [...empty, ...unknownCommands, ...duplicates];
}

/** The table object and its owner, when `init` is `{…} as const satisfies ReasonTable<'owner'>`. */
function reasonTableMarker(
  init: unknown,
): Readonly<{ object: AstNode; owner: string }> | undefined {
  const node = init as AstNode | null | undefined;
  if (node?.type !== 'TSSatisfiesExpression') return undefined;
  const annotation = node.typeAnnotation as AstNode;
  if (annotation.type !== 'TSTypeReference' || propertyName(annotation.typeName) !== TABLE_TYPE) {
    return undefined;
  }
  const where = `a ${TABLE_TYPE} at offset ${String(node.start)}`;
  const constant = node.expression as AstNode;
  const isConst =
    constant.type === 'TSAsExpression' &&
    propertyName((constant.typeAnnotation as AstNode).typeName) === 'const';
  const object = isConst ? (constant.expression as AstNode) : undefined;
  if (object?.type !== 'ObjectExpression') {
    throw new TypeError(`${where} must be an object literal declared \`as const\`.`);
  }
  const parameters = ((annotation.typeArguments as AstNode | undefined)?.params ?? []) as AstNode[];
  const literal = parameters[0]?.type === 'TSLiteralType' ? parameters[0].literal : undefined;
  const owner = stringLiteral(literal);
  if (parameters.length !== 1 || owner === undefined) {
    throw new TypeError(`${where} must name its owner command or subsystem as one string literal.`);
  }
  return { object, owner };
}

function readRows(object: AstNode, where: string): CollectedReasonRow[] {
  return (object.properties as AstNode[]).map((property) => {
    const member = property.type === 'Property' ? propertyName(property.key) : undefined;
    const row = property.value as AstNode | undefined;
    if (member === undefined || property.computed === true || row?.type !== 'ObjectExpression') {
      throw new TypeError(`${where} has a member that is not a named row object literal.`);
    }
    const fields = new Map<string, AstNode>();
    for (const field of row.properties as AstNode[]) {
      const key = field.type === 'Property' ? propertyName(field.key) : undefined;
      if (key === undefined) throw new TypeError(`${where}.${member} has an unreadable field.`);
      fields.set(key, field.value as AstNode);
    }
    const reason = stringLiteral(fields.get('reason'));
    const summary = stringLiteral(fields.get('summary'));
    if (reason === undefined || summary === undefined) {
      throw new TypeError(`${where}.${member} must write \`reason\` and \`summary\` as literals.`);
    }
    return {
      member,
      reason,
      summary,
      commands: readCommands(fields.get('commands'), where, member),
    };
  });
}

function readCommands(node: AstNode | undefined, where: string, member: string): string[] {
  if (node === undefined) return [];
  const elements = node.type === 'ArrayExpression' ? (node.elements as AstNode[]) : undefined;
  const commands = elements?.map(stringLiteral);
  if (commands === undefined || commands.some((command) => command === undefined)) {
    throw new TypeError(`${where}.${member} must list \`commands\` as string literals.`);
  }
  return commands as string[];
}

function stringLiteral(node: unknown): string | undefined {
  const value = node as AstNode | undefined;
  if (value?.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value?.type === 'TemplateLiteral' && (value.expressions as unknown[]).length === 0) {
    return ((value.quasis as AstNode[])[0]!.value as AstNode).cooked as string;
  }
  return undefined;
}
