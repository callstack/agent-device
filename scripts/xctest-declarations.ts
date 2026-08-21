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
// PBXFileSystemSynchronizedRootGroup, so membership is the directory, not a file list. A
// `RunnerTests*` name filter would miss RunnerTapPointPolicy.swift, which declares a real
// addressable test inside `extension RunnerTests`.
const SWIFT_SOURCE = /\.swift$/;

// One ordered pass over the source. A column-0 type declaration moves the enclosing type;
// a `func test…` indented exactly one level binds to it. Position carries the meaning
// rather than brace counting, which would have to know which `{` sits inside a string
// literal. It is also the more precise rule: only a method declared directly in a
// top-level `class`/`extension` block is addressable as `Target/Class/method`, so a
// helper type nested inside a test body (`final class ResultBox` — several of these
// exist) contributes no test identifiers, and neither does a closure-local `func test…`.
const DECLARATION =
  /^(?:[\w@]+[ \t]+)*(?:class|extension|struct|enum|actor|protocol)[ \t]+([A-Za-z_]\w*)|^ {2}(?:[\w@]+[ \t]+)*func[ \t]+(test\w*)[ \t]*\(/gm;

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
  const declared = new Set<string>();
  for (const source of sources) {
    let enclosing = '';
    for (const [, type, method] of source.text.matchAll(DECLARATION)) {
      if (type !== undefined) enclosing = type;
      else if (method !== undefined && enclosing) declared.add(`${target}/${enclosing}/${method}`);
    }
  }
  return [...declared].sort();
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
