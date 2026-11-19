import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';

export const PROJECT_ROOT = path.resolve(import.meta.dirname, '../..');

const RUNNER_SOURCES_DIR = path.join(
  PROJECT_ROOT,
  'apple',
  'runner',
  'AgentDeviceRunner',
  'AgentDeviceRunnerUITests',
);

export function assertRunnerSourceIncludes(via: string, context: string): void {
  const [fileName, symbol] = via.split('#');
  assert.ok(fileName && symbol, `${context}: runner via must be "<file>#<symbol>", got "${via}"`);
  const absolute = path.join(RUNNER_SOURCES_DIR, fileName);
  assert.ok(fs.existsSync(absolute), `${context}: runner source not found: ${fileName}`);
  assert.ok(
    fs.readFileSync(absolute, 'utf8').includes(symbol),
    `${context}: "${symbol}" not found in ${fileName}`,
  );
}

// ── Swift helpers shared by the runner-code guards ──

/** Every production runner Swift file: the UITests sources, excluding the UnitTests subtree. */
export function runnerProductionSources(): Array<{ file: string; source: string }> {
  return fs
    .readdirSync(RUNNER_SOURCES_DIR)
    .filter((name) => name.endsWith('.swift'))
    .map((name) => ({
      file: name,
      source: fs.readFileSync(path.join(RUNNER_SOURCES_DIR, name), 'utf8'),
    }));
}

/**
 * The string values one Swift enum declares as `static let NAME = "CODE"`, read from the source
 * text between the enum's opening line and its closing brace.
 */
export function swiftEnumWireCodes(source: string, enumName: string): string[] {
  return swiftEnumWireConstants(source, enumName).map(({ code }) => code);
}

/** The `name`/`code` pairs one Swift enum declares as `static let NAME = "CODE"`. */
export function swiftEnumWireConstants(
  source: string,
  enumName: string,
): Array<{ name: string; code: string }> {
  const declaration = new RegExp(`enum ${enumName}[^{]*\\{([\\s\\S]*?)\\n[ \\t]*\\}`).exec(source);
  assert.ok(declaration !== null, `the runner Swift must declare enum ${enumName} with a body`);
  return [...declaration[1]!.matchAll(/static let (\w+) = "([A-Z0-9_]+)"/g)].map(
    ([, name, code]) => ({ name: name!, code: code! }),
  );
}

/** The source text of one Swift enum, body markers included, for exclusion from scans. */
export function swiftEnumBody(source: string, enumName: string): string {
  const declaration = new RegExp(`enum ${enumName}[^{]*\\{[\\s\\S]*?\\n[ \\t]*\\}`).exec(source);
  assert.ok(declaration !== null, `the runner Swift must declare enum ${enumName} with a body`);
  return declaration[0]!;
}

/** One code literal found by {@link swiftCodeLiteralSites}, with the position it sits in. */
export type SwiftCodeLiteralSite = Readonly<{
  file: string;
  line: number;
  code: string;
  kind: 'emit' | 'binding' | 'rawValue';
}>;

/**
 * Every UPPER_SNAKE string literal the production runner Swift puts where a wire code can travel,
 * with the position that decides what may appear there:
 * - `emit`: a `code:`/`errorCode:`/`wireCode:`/`lifecycleErrorCode:` argument. Only a top-level
 *   family code may appear here; every runner code must travel through its enum constant.
 * - `binding`: a `let`/`var` (typically `static let`) or a `return` whose value is the literal.
 *   Same rule as an emit site: this is a name a caller can pass on, and the enums are the only
 *   place a runner code may be spelled.
 * - `rawValue`: a `case … = "CODE"` raw value. Swift allows only a literal here, so the two
 *   refusal enums keep theirs and the rule is vocabulary closure instead: the code must be
 *   declared on the host side.
 * A position stays open across lines when the value cannot sit on the opening line yet — a bare
 * `code:` label, a wrapped ternary arm after ` ?` / ` :`, `let code =`, or a computed
 * `var code: String {` — so a formatter-driven wrap cannot drop a literal out of the scan. The
 * open kind carries until a `}`, `)` or `;` closes the expression. Comment text is skipped.
 */
export function swiftCodeLiteralSites(
  sources: ReadonlyArray<{ file: string; source: string }>,
): SwiftCodeLiteralSite[] {
  const sites: SwiftCodeLiteralSite[] = [];
  for (const { file, source } of sources) {
    const lines = source.split('\n');
    let open: SwiftCodeLiteralSite['kind'] | undefined;
    for (let index = 0; index < lines.length; index++) {
      const line = (lines[index] ?? '').replace(/\/\/.*/, '');
      const kind = swiftCodeLiteralKind(line) ?? open;
      for (const match of line.matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) {
        if (kind !== undefined) sites.push({ file, line: index + 1, code: match[1]!, kind });
      }
      const afterLine = swiftOpenPositionAfterLine(line, swiftCodeLiteralKind(line));
      open = afterLine === 'keep' ? kind : afterLine;
    }
  }
  return sites;
}

/** The code position one comment-stripped Swift line occupies, or undefined for neither. */
function swiftCodeLiteralKind(line: string): SwiftCodeLiteralSite['kind'] | undefined {
  if (/\b(?:code|errorCode|wireCode|lifecycleErrorCode)\s*[:=]/.test(line)) return 'emit';
  if (/\bcase\s+[A-Za-z_]\w*\s*=\s*"[A-Z][A-Z0-9_]{3,}"/.test(line)) return 'rawValue';
  if (/\b(?:let|var)\s+[A-Za-z_]\w*(?:\s*:\s*String)?\s*=\s*"[A-Z][A-Z0-9_]{3,}"/.test(line)) {
    return 'binding';
  }
  return /\breturn\s+"[A-Z][A-Z0-9_]{3,}"/.test(line) ? 'binding' : undefined;
}

/**
 * Whether a code position is still open after one line: `keep` means the previous openness
 * stands; a kind means this line opened (or restated) that position with its value not yet
 * written — a bare `code:` label, a `let`/`var` whose `=` ends the line, a bare `return`, or a
 * classified line left open by ` ?`, ` :`, `{`, `(` or `=`. undefined means the position
 * closed: this line wrote its value, or a `}`, `)` or `;` ended the expression.
 */
function swiftOpenPositionAfterLine(
  line: string,
  kind: SwiftCodeLiteralSite['kind'] | undefined,
): SwiftCodeLiteralSite['kind'] | 'keep' | undefined {
  if (kind !== undefined) {
    const labelOnly = /^\s*(?:code|errorCode|wireCode|lifecycleErrorCode)\s*:\s*$/.test(line);
    return labelOnly || /[ \t][?:({]\s*$/.test(line) || /=\s*$/.test(line) ? kind : undefined;
  }
  if (/[});]/.test(line)) return undefined;
  if (/^\s*(?:let|var)\s+[A-Za-z_]\w*[^=]*=\s*$/.test(line)) return 'binding';
  if (/^\s*return\s*$/.test(line)) return 'binding';
  return 'keep';
}

// ── oxc helpers shared by the reason-table guards ──

/** Parses TypeScript source, failing the test on any parse error. */
export function parseTs(filename: string, source: string) {
  const parsed = parseSync(filename, source);
  assert.deepEqual(parsed.errors, [], `${filename} must parse`);
  return parsed;
}

/** Unwraps `as const`, `satisfies …`, assertions and parentheses around an expression. */
export function unwrapAssertion(node: unknown): any {
  let current = node as any;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression')
  ) {
    current = current.expression;
  }
  return current;
}

/** The object literal an exported const names, assertions unwrapped, so a guard reads the rows. */
export function exportedConstObject(parsed: ReturnType<typeof parseSync>, name: string) {
  const statement = parsed.program.body.find(
    (candidate) =>
      candidate.type === 'ExportNamedDeclaration' &&
      candidate.declaration?.type === 'VariableDeclaration' &&
      candidate.declaration.declarations.some(
        (declaration) => declaration.id.type === 'Identifier' && declaration.id.name === name,
      ),
  );
  if (
    statement === undefined ||
    statement.type !== 'ExportNamedDeclaration' ||
    statement.declaration?.type !== 'VariableDeclaration'
  ) {
    assert.fail(`the source must export the const ${name}`);
  }
  const declaration = statement.declaration.declarations.find(
    (candidate) => candidate.id.type === 'Identifier' && candidate.id.name === name,
  );
  const initializer = unwrapAssertion(declaration?.init);
  assert.ok(
    declaration !== undefined && initializer?.type === 'ObjectExpression',
    `${name} must be an exported object literal, not ${initializer?.type ?? 'nothing'}`,
  );
  return initializer;
}

/** The string members of an exported `as const` array (e.g. KNOWN_APP_ERROR_CODES). */
export function exportedConstArrayValues(source: string, name: string): string[] {
  const parsed = parseTs(`${name}.ts`, source);
  const statement = parsed.program.body.find(
    (candidate) =>
      candidate.type === 'ExportNamedDeclaration' &&
      candidate.declaration?.type === 'VariableDeclaration' &&
      candidate.declaration.declarations.some(
        (declaration) => declaration.id.type === 'Identifier' && declaration.id.name === name,
      ),
  );
  assert.ok(
    statement?.type === 'ExportNamedDeclaration' &&
      statement.declaration?.type === 'VariableDeclaration',
    `the source must export the const ${name}`,
  );
  const declaration = statement.declaration.declarations.find(
    (candidate) => candidate.id.type === 'Identifier' && candidate.id.name === name,
  );
  const initializer = unwrapAssertion(declaration?.init);
  assert.ok(
    initializer?.type === 'ArrayExpression',
    `${name} must be an exported array literal, not ${initializer?.type ?? 'nothing'}`,
  );
  return initializer.elements.map((element: any) => {
    assert.ok(element?.type === 'Literal' && typeof element.value === 'string');
    return element.value as string;
  });
}

export function readRepoFile(relativePath: string): string {
  return fs.readFileSync(path.join(PROJECT_ROOT, relativePath), 'utf8');
}
