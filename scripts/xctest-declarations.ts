// What the runner's XCTest target declares, and on which platforms — the scan behind
// "which lane reaches what" (`check-xctest-selection.ts`), kept separate because it answers a
// different question: this module reads Swift sources, that one reads workflow manifests.
//
// The per-platform attribution is the whole point. A `func test…` is not simply "declared":
// it is declared *for the platforms whose `#if` guards let it compile*, which is what makes a
// test's guard its lane classification (#1781 A7).

import fs from 'node:fs';
import path from 'node:path';
import { activeSource, PLATFORMS, type Platform } from './swift-conditional-compilation.ts';

/** The XCTest target directory; its basename is the target name the identifiers use. */
export const RUNNER_TESTS_DIR = 'apple/runner/AgentDeviceRunner/AgentDeviceRunnerUITests';

// Every .swift file below the target directory is a member: the Xcode project uses a
// PBXFileSystemSynchronizedRootGroup, so membership is the directory, not a file list, and a
// file's name says nothing about whether it declares addressable tests.
const SWIFT_SOURCE = /\.swift$/;

// Swift ignores indentation, but the runner tests use it consistently to distinguish
// methods from functions local to a method. The type and method may each be indented by
// a surrounding #if block; requiring column zero or exactly two spaces misses valid tests.
const TYPE_DECLARATION =
  /^([ \t]*)(?:[\w@]+[ \t]+)*(?:class|extension|struct|enum|actor|protocol)[ \t]+([A-Za-z_]\w*)\b/;
const FUNCTION_DECLARATION = /^([ \t]*)(?:[\w@]+[ \t]+)*func[ \t]+([A-Za-z_]\w*)/;
const TEST_DECLARATION = /^([ \t]*)(?:[\w@]+[ \t]+)*func[ \t]+(test\w*)[ \t]*\(/;

export type SwiftSource = { readonly file: string; readonly text: string };

/** A declared method and the platforms its `#if` guards let it compile for. */
export type DeclaredTest = {
  readonly identifier: string;
  readonly platforms: readonly Platform[];
};

export function readSwiftSources(directory: string): SwiftSource[] {
  const files: string[] = [];
  collectSwiftSourcePaths(directory, '', files);
  return files.sort().map((file) => ({
    file,
    text: fs.readFileSync(path.join(directory, file), 'utf8'),
  }));
}

function collectSwiftSourcePaths(directory: string, relativeDirectory: string, files: string[]) {
  const currentDirectory = path.join(directory, relativeDirectory);
  for (const entry of fs.readdirSync(currentDirectory, { withFileTypes: true })) {
    const relativePath = path.join(relativeDirectory, entry.name);
    if (entry.isDirectory()) {
      collectSwiftSourcePaths(directory, relativePath, files);
    } else if (entry.isFile() && SWIFT_SOURCE.test(entry.name)) {
      files.push(relativePath);
    }
  }
}

/** Every `Target/Class/method` identifier the sources declare, sorted, guards ignored. */
export function parseDeclaredTests(target: string, sources: readonly SwiftSource[]): string[] {
  return [...new Set(sources.flatMap((source) => declarationsInSource(target, source)))].sort();
}

type DeclarationScope = {
  enclosing?: { name: string; indent: number };
  nestedTypeIndent?: number;
  functionIndent?: number;
};

function declarationsInSource(target: string, source: SwiftSource): string[] {
  const scope: DeclarationScope = {};
  const declared: string[] = [];
  for (const [index, line] of source.text.split('\n').entries()) {
    if (/^[ \t]*(?:\/\/|\/\*|\*)/.test(line)) continue;
    const indent = line.match(/^[ \t]*/)?.[0].length ?? 0;
    const error = () => unrecognizedDeclaration(source.file, index + 1, line);
    if (/\bfunc[ \t]+test\w*/.test(line) && !FUNCTION_DECLARATION.test(line)) throw error();
    closeScopes(scope, line, indent);
    if (readTypeDeclaration(scope, line, indent)) continue;
    const method = readTestDeclaration(scope, line, indent, error);
    if (method) declared.push(`${target}/${method}`);
  }
  return declared;
}

function unrecognizedDeclaration(file: string, lineNumber: number, line: string): Error {
  return new Error(`${file}:${lineNumber}: unrecognized XCTest declaration: ${line.trim()}`);
}

function closeScopes(scope: DeclarationScope, line: string, indent: number): void {
  if (!/^[ \t]*}/.test(line)) return;
  if (scope.functionIndent !== undefined && indent <= scope.functionIndent)
    scope.functionIndent = undefined;
  if (scope.nestedTypeIndent !== undefined && indent <= scope.nestedTypeIndent)
    scope.nestedTypeIndent = undefined;
  if (scope.enclosing && indent <= scope.enclosing.indent) scope.enclosing = undefined;
}

function readTypeDeclaration(scope: DeclarationScope, line: string, indent: number): boolean {
  const type = TYPE_DECLARATION.exec(line);
  if (!type) return false;
  if (!scope.enclosing) scope.enclosing = { name: type[2]!, indent };
  else if (indent > scope.enclosing.indent && scope.functionIndent === undefined)
    scope.nestedTypeIndent = indent;
  return true;
}

function readTestDeclaration(
  scope: DeclarationScope,
  line: string,
  indent: number,
  error: () => Error,
): string | undefined {
  const func = FUNCTION_DECLARATION.exec(line);
  if (!func) return undefined;
  const local = isLocalFunction(scope, indent);
  markFunctionScope(scope, indent, local);
  const name = func[2]!;
  if (local || !name.startsWith('test')) return undefined;
  return checkedTestName(scope, line, indent, name, error);
}

function isLocalFunction(scope: DeclarationScope, indent: number): boolean {
  return (
    (scope.functionIndent !== undefined && indent > scope.functionIndent) ||
    (scope.nestedTypeIndent !== undefined && indent > scope.nestedTypeIndent)
  );
}

function markFunctionScope(scope: DeclarationScope, indent: number, local: boolean): void {
  if (!scope.enclosing || indent <= scope.enclosing.indent) return;
  if (scope.functionIndent !== undefined || local) return;
  scope.functionIndent = indent;
}

function checkedTestName(
  scope: DeclarationScope,
  line: string,
  indent: number,
  name: string,
  error: () => Error,
): string {
  const enclosing = scope.enclosing;
  if (!enclosing || indent <= enclosing.indent || !TEST_DECLARATION.test(line)) throw error();
  return `${enclosing.name}/${name}`;
}

/** The declared identifiers, each with the platforms whose unit-test build compiles it. */
export function parseDeclaredTestsByPlatform(
  target: string,
  sources: readonly SwiftSource[],
): DeclaredTest[] {
  const compiled = new Map<Platform, Set<string>>(
    PLATFORMS.map((platform) => [
      platform,
      new Set(
        parseDeclaredTests(
          target,
          sources.map((source) => ({
            file: source.file,
            text: activeSource(source.text, platform, source.file),
          })),
        ),
      ),
    ]),
  );
  return parseDeclaredTests(target, sources).map((identifier) => ({
    identifier,
    platforms: PLATFORMS.filter((platform) => compiled.get(platform)?.has(identifier)),
  }));
}
