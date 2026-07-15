#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNIT_TEST_CONDITION = 'AGENT_DEVICE_RUNNER_UNIT_TESTS';
const SOURCE_DIR = path.join('apple', 'runner');
const OUTPUT_DIR = path.join('dist', 'apple', 'runner');
// Packaged-runner locations from before the apple-runner/ -> apple/runner/ move. `dist` ships
// wholesale, so a stale tree left by an older build/checkout would double-ship into the npm
// package (and inflate the bundle-size diff, which packages the base then the PR into one dist).
// Always remove them so only the current OUTPUT_DIR survives.
const LEGACY_OUTPUT_DIRS = [
  path.join('dist', 'apple-runner'),
  path.join('dist', 'apple', 'apple-runner'),
];
const SKIPPED_DIR_NAMES = new Set(['.build', '.swiftpm', 'xcuserdata']);
const SKIPPED_ROOT_FILES = new Set(['README.md', 'RUNNER_PROTOCOL.md']);

export function packageAppleRunnerSource(options = {}) {
  const root = path.resolve(options.root ?? process.cwd());
  const sourceRoot = path.join(root, SOURCE_DIR);
  const outputRoot = path.join(root, OUTPUT_DIR);
  if (!fs.existsSync(sourceRoot)) {
    throw new Error(`Apple runner source not found at ${sourceRoot}`);
  }

  fs.rmSync(outputRoot, { recursive: true, force: true });
  for (const legacyDir of LEGACY_OUTPUT_DIRS) {
    fs.rmSync(path.join(root, legacyDir), { recursive: true, force: true });
  }
  const summary = {
    outputRoot,
    copiedFiles: 0,
    strippedFiles: 0,
    strippedBlocks: 0,
  };

  copyDirectory(sourceRoot, outputRoot, '', summary);
  return summary;
}

export function stripRunnerUnitTestBlocks(source, filePath = '<swift source>') {
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

function copyDirectory(sourceDir, outputDir, relativeDir, summary) {
  fs.mkdirSync(outputDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    copyDirectoryEntry(entry, sourceDir, outputDir, relativeDir, summary);
  }
}

function copyDirectoryEntry(entry, sourceDir, outputDir, relativeDir, summary) {
  const relativePath = path.join(relativeDir, entry.name);
  if (shouldSkipEntry(entry, relativePath)) {
    return;
  }

  const sourcePath = path.join(sourceDir, entry.name);
  const outputPath = path.join(outputDir, entry.name);
  if (entry.isDirectory()) {
    copyDirectory(sourcePath, outputPath, relativePath, summary);
    return;
  }
  if (entry.isFile()) {
    copyFile(sourcePath, outputPath, summary);
  }
}

function copyFile(sourcePath, outputPath, summary) {
  if (path.extname(sourcePath) !== '.swift') {
    fs.copyFileSync(sourcePath, outputPath);
    summary.copiedFiles += 1;
    return;
  }

  const source = fs.readFileSync(sourcePath, 'utf8');
  const stripped = stripRunnerUnitTestBlocks(source, sourcePath);
  fs.writeFileSync(outputPath, stripped.contents);
  summary.copiedFiles += 1;
  if (stripped.strippedBlocks > 0) {
    summary.strippedFiles += 1;
    summary.strippedBlocks += stripped.strippedBlocks;
  }
}

function shouldSkipEntry(entry, relativePath) {
  return shouldSkipDirectory(entry) || shouldSkipFile(entry, relativePath);
}

function shouldSkipDirectory(entry) {
  return entry.isDirectory() && SKIPPED_DIR_NAMES.has(entry.name);
}

function shouldSkipFile(entry, relativePath) {
  return entry.isFile() && (isXcodeUserStateFile(entry) || isSkippedRootFile(entry, relativePath));
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
  const parsed = { root: process.cwd(), quiet: false };
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
    const relativeOutput = path.relative(path.resolve(options.root), summary.outputRoot);
    console.log(
      `Packaged Apple runner source at ${relativeOutput} ` +
        `(${summary.copiedFiles} files, stripped ${summary.strippedBlocks} unit-test blocks).`,
    );
  }
}
