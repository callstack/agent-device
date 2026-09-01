#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNIT_TEST_CONDITION = 'AGENT_DEVICE_RUNNER_UNIT_TESTS';
const SOURCE_DIR = path.join('apple', 'runner');
const OUTPUT_DIR = path.join('dist', 'apple', 'runner');
const SNAPSHOT_PRESENTATION_SOURCE_DIR = path.join('apple', 'snapshot-presentation');
const SNAPSHOT_PRESENTATION_OUTPUT_DIR = path.join('dist', 'apple', 'snapshot-presentation');
const SNAPSHOT_PRESENTATION_RUNNER_MANIFEST = 'Package.runner.swift';
const SNAPSHOT_PRESENTATION_DEVELOPMENT_DIR_NAMES = new Set([
  'Tests',
  'SnapshotPresentationConformance',
  '.build',
  '.swiftpm',
  'UnitTests',
  'xcuserdata',
]);
// Packaged-runner locations from before the apple-runner/ -> apple/runner/ move. `dist` ships
// wholesale, so a stale tree left by an older build/checkout would double-ship into the npm
// package (and inflate the bundle-size diff, which packages the base then the PR into one dist).
// Always remove them so only the current OUTPUT_DIR survives.
const LEGACY_OUTPUT_DIRS = [
  path.join('dist', 'apple-runner'),
  path.join('dist', 'apple', 'apple-runner'),
];
const SKIPPED_DIR_NAMES = new Set(['.build', '.swiftpm', 'UnitTests', 'xcuserdata']);
const SKIPPED_ROOT_FILES = new Set(['README.md', 'RUNNER_PROTOCOL.md']);
// XCTest discovers instance methods named test*; anything matching this that survives stripping
// would ship to (and compile on) every user's machine. Only the runner's command-loop entrypoint
// is a legitimate test method in the packaged source.
const SHIPPED_TEST_METHOD_ALLOWLIST = new Map([
  [
    path.join('AgentDeviceRunner', 'AgentDeviceRunnerUITests', 'RunnerTests.swift'),
    new Set(['testCommand']),
  ],
]);
const TEST_METHOD_PATTERN = /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:\w+\s+)*func\s+(test\w*)\s*\(/;

function packageAppleRunnerSource(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const sourceRoot = path.join(root, SOURCE_DIR);
  const outputRoot = path.join(root, OUTPUT_DIR);
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`Apple runner source not found at ${sourceRoot}`);
  }

  prepareOutput(root, outputRoot, options.checkOnly);
  const summary = {
    outputRoot,
    copiedFiles: 0,
    strippedFiles: 0,
    strippedBlocks: 0,
  };

  processDirectory(sourceRoot, options.checkOnly ? undefined : outputRoot, '', summary);
  packageSnapshotPresentationSource(root, options, summary);
  return summary;
}

function packageSnapshotPresentationSource(root, options, summary) {
  const sourceRoot = path.join(root, SNAPSHOT_PRESENTATION_SOURCE_DIR);
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`Apple snapshot presentation source not found at ${sourceRoot}`);
  }
  const outputRoot = path.join(root, SNAPSHOT_PRESENTATION_OUTPUT_DIR);
  const manifestSource = requireSnapshotPresentationManifest(sourceRoot);
  processDirectory(sourceRoot, options.checkOnly ? undefined : outputRoot, '', summary, {
    validateSwift: false,
    skipDirectoryNames: SNAPSHOT_PRESENTATION_DEVELOPMENT_DIR_NAMES,
    skipFilePaths: new Set(['Package.swift', SNAPSHOT_PRESENTATION_RUNNER_MANIFEST]),
  });
  copySnapshotPresentationManifest(manifestSource, outputRoot, summary, options.checkOnly);
}

function requireSnapshotPresentationManifest(sourceRoot) {
  const manifestSource = path.join(sourceRoot, SNAPSHOT_PRESENTATION_RUNNER_MANIFEST);
  if (fs.existsSync(manifestSource)) return manifestSource;
  throw new Error(`Apple snapshot presentation runner manifest not found at ${manifestSource}`);
}

function copySnapshotPresentationManifest(manifestSource, outputRoot, summary, checkOnly) {
  if (checkOnly) return;
  fs.copyFileSync(manifestSource, path.join(outputRoot, 'Package.swift'));
  summary.copiedFiles += 1;
}

function prepareOutput(root, outputRoot, checkOnly) {
  if (checkOnly) {
    return;
  }
  fs.rmSync(outputRoot, { recursive: true, force: true });
  fs.rmSync(path.join(root, SNAPSHOT_PRESENTATION_OUTPUT_DIR), { recursive: true, force: true });
  for (const legacyDir of LEGACY_OUTPUT_DIRS) {
    fs.rmSync(path.join(root, legacyDir), { recursive: true, force: true });
  }
}

function stripRunnerUnitTestBlocks(source, filePath = '<swift source>') {
  const lines = source.match(/[^\n]*\n|[^\n]+/g) ?? [];
  const state = {
    output: [],
    strippedBlocks: 0,
    skippedDepth: 0,
  };

  for (const line of lines) {
    consumeSwiftLine(state, line);
  }

  if (state.skippedDepth !== 0) {
    throw new Error(`Unterminated ${UNIT_TEST_CONDITION} block in ${filePath}`);
  }

  return {
    contents: state.output.join(''),
    strippedBlocks: state.strippedBlocks,
  };
}

function consumeSwiftLine(state, line) {
  if (state.skippedDepth > 0) {
    consumeSkippedConditionalLine(state, line);
    return;
  }
  if (isRunnerUnitTestBlockStart(line)) {
    state.skippedDepth = 1;
    state.strippedBlocks += 1;
    return;
  }
  state.output.push(line);
}

function consumeSkippedConditionalLine(state, line) {
  if (isConditionalStart(line)) {
    state.skippedDepth += 1;
  }
  if (isConditionalEnd(line)) {
    state.skippedDepth -= 1;
  }
}

function processDirectory(sourceDir, outputDir, relativeDir, summary, options = {}) {
  if (outputDir) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    processDirectoryEntry(entry, sourceDir, outputDir, relativeDir, summary, options);
  }
}

function processDirectoryEntry(entry, sourceDir, outputDir, relativeDir, summary, options) {
  const relativePath = path.join(relativeDir, entry.name);
  if (shouldSkipEntry(entry, relativePath, options)) {
    return;
  }

  processIncludedEntry(entry, sourceDir, outputDir, relativePath, summary, options);
}

function processIncludedEntry(entry, sourceDir, outputDir, relativePath, summary, options) {
  const sourcePath = path.join(sourceDir, entry.name);
  const outputPath = outputDir ? path.join(outputDir, entry.name) : undefined;
  if (entry.isDirectory()) {
    processDirectory(sourcePath, outputPath, relativePath, summary, options);
    return;
  }
  if (!entry.isFile()) {
    return;
  }
  processFile(sourcePath, outputPath, relativePath, summary, options);
}

function processFile(sourcePath, outputPath, relativePath, summary, options) {
  if (outputPath) {
    copyFile(sourcePath, outputPath, relativePath, summary, options);
    return;
  }
  validateFile(sourcePath, relativePath, summary, options);
}

function copyFile(sourcePath, outputPath, relativePath, summary, options) {
  if (path.extname(sourcePath) !== '.swift') {
    fs.copyFileSync(sourcePath, outputPath);
    summary.copiedFiles += 1;
    return;
  }

  if (options.validateSwift === false) {
    fs.copyFileSync(sourcePath, outputPath);
    summary.copiedFiles += 1;
    return;
  }

  const stripped = validateSwiftFile(sourcePath, relativePath, summary);
  fs.writeFileSync(outputPath, stripped.contents);
  summary.copiedFiles += 1;
}

function validateFile(sourcePath, relativePath, summary, options) {
  if (path.extname(sourcePath) !== '.swift') {
    return undefined;
  }
  if (options.validateSwift === false) {
    return undefined;
  }
  return validateSwiftFile(sourcePath, relativePath, summary);
}

function validateSwiftFile(sourcePath, relativePath, summary) {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const stripped = stripRunnerUnitTestBlocks(source, sourcePath);
  assertNoShippedTestMethods(stripped.contents, relativePath);
  if (stripped.strippedBlocks > 0) {
    summary.strippedFiles += 1;
    summary.strippedBlocks += stripped.strippedBlocks;
  }
  return stripped;
}

function assertNoShippedTestMethods(strippedContents, relativePath) {
  const allowedMethods = SHIPPED_TEST_METHOD_ALLOWLIST.get(relativePath) ?? new Set();
  const shippedMethods = strippedContents
    .split('\n')
    .map((line) => TEST_METHOD_PATTERN.exec(line)?.[1])
    .filter((method) => method !== undefined && !allowedMethods.has(method));
  if (shippedMethods.length > 0) {
    throw new Error(
      `Unit test ${shippedMethods[0]}() in ${relativePath} would ship in the npm package; ` +
        `wrap it in #if ${UNIT_TEST_CONDITION}.`,
    );
  }
}

function shouldSkipEntry(entry, relativePath, options) {
  return shouldSkipDirectory(entry, options) || shouldSkipFile(entry, relativePath, options);
}

function shouldSkipDirectory(entry, options) {
  return entry.isDirectory() && (options.skipDirectoryNames ?? SKIPPED_DIR_NAMES).has(entry.name);
}

function shouldSkipFile(entry, relativePath, options) {
  return (
    entry.isFile() &&
    (isXcodeUserStateFile(entry) ||
      isSkippedRootFile(entry, relativePath) ||
      options.skipFilePaths?.has(relativePath) === true)
  );
}

function isXcodeUserStateFile(entry) {
  return entry.name.endsWith('.xcuserstate');
}

function isSkippedRootFile(entry, relativePath) {
  return !relativePath.includes(path.sep) && SKIPPED_ROOT_FILES.has(entry.name);
}

function isRunnerUnitTestBlockStart(line) {
  return new RegExp(`^\\s*#if\\s+${UNIT_TEST_CONDITION}(?:\\b|$)`).test(line);
}

function isConditionalStart(line) {
  return /^\s*#if\b/.test(line);
}

function isConditionalEnd(line) {
  return /^\s*#endif\b/.test(line);
}

function parseArgs(argv) {
  const parsed = { root: process.cwd(), quiet: false, checkOnly: false };
  let index = 0;
  while (index < argv.length) {
    index = parseArg(argv, index, parsed);
  }
  return parsed;
}

function parseArg(argv, index, parsed) {
  const arg = argv[index];
  if (arg === '--quiet') {
    parsed.quiet = true;
    return index + 1;
  }
  if (arg === '--check') {
    parsed.checkOnly = true;
    return index + 1;
  }
  if (arg === '--root') {
    return parseRootArg(argv, index, parsed);
  }
  throw new Error(`Unknown argument: ${arg}`);
}

function parseRootArg(argv, index, parsed) {
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) {
    throw new Error('--root requires a path');
  }
  parsed.root = value;
  return index + 2;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const options = parseArgs(process.argv.slice(2));
  const summary = packageAppleRunnerSource(options);
  if (!options.quiet) {
    if (options.checkOnly) {
      console.log(
        `Apple runner source package guard passed ` +
          `(${summary.strippedFiles} files contain ${summary.strippedBlocks} stripped blocks).`,
      );
    } else {
      const relativeOutput = path.relative(path.resolve(options.root), summary.outputRoot);
      console.log(
        `Packaged Apple runner source at ${relativeOutput} ` +
          `(${summary.copiedFiles} files, stripped ${summary.strippedBlocks} unit-test blocks).`,
      );
    }
  }
}
