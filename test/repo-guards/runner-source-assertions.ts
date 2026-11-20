import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseSync } from 'oxc-parser';
import { stripSwiftComments } from '../../scripts/strip-swift-comments.mjs';

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

/** One UPPER_SNAKE string literal in production runner Swift. */
export type SwiftUpperSnakeLiteral = Readonly<{
  file: string;
  line: number;
  code: string;
  /** The literal is the raw value of a `case name = "CODE"` on its own line. */
  rawValueCase: boolean;
  /** The literal is the direct argument of `NSLog(` or the key of an `environment[` read. */
  markOrEnvName: boolean;
}>;

/**
 * Every UPPER_SNAKE string literal in the given Swift sources, comments stripped. The scan reads
 * no syntax around the literal, so no wrap style, operator or nested call can hide one: what a
 * literal may spell is decided by the caller from its value and file alone.
 */
export function swiftUpperSnakeLiterals(
  sources: ReadonlyArray<{ file: string; source: string }>,
): SwiftUpperSnakeLiteral[] {
  const literals: SwiftUpperSnakeLiteral[] = [];
  for (const { file, source } of sources) {
    const lines = stripSwiftComments(source, file).contents.split('\n');
    lines.forEach((line, index) => {
      const rawValueCase = /^\s*case\s+[A-Za-z_]\w*\s*=\s*"[A-Z][A-Z0-9_]{3,}"\s*$/.test(line);
      for (const match of line.matchAll(/"([A-Z][A-Z0-9_]{3,})"/g)) {
        const markOrEnvName = /(?:\bNSLog\(|\benvironment\[)$/.test(line.slice(0, match.index));
        literals.push({ file, line: index + 1, code: match[1]!, rawValueCase, markOrEnvName });
      }
    });
  }
  return literals;
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
