#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const UNIT_TEST_CONDITION = 'AGENT_DEVICE_RUNNER_UNIT_TESTS';
const SOURCE_DIR = path.join('apple-runner');
const OUTPUT_DIR = path.join('dist', 'apple-runner');
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
  const output = [];
  let strippedBlocks = 0;
  let skippedDepth = 0;

  for (const line of lines) {
    if (skippedDepth === 0) {
      if (isRunnerUnitTestBlockStart(line)) {
        skippedDepth = 1;
        strippedBlocks += 1;
        continue;
      }
      output.push(line);
      continue;
    }

    if (isConditionalStart(line)) {
      skippedDepth += 1;
    }
    if (isConditionalEnd(line)) {
      skippedDepth -= 1;
    }
  }

  if (skippedDepth !== 0) {
    throw new Error(`Unterminated ${UNIT_TEST_CONDITION} block in ${filePath}`);
  }

  return {
    contents: output.join(''),
    strippedBlocks,
  };
}

function copyDirectory(sourceDir, outputDir, relativeDir, summary) {
  fs.mkdirSync(outputDir, { recursive: true });
  const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);
    if (shouldSkipEntry(entry, relativePath)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const outputPath = path.join(outputDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectory(sourcePath, outputPath, relativePath, summary);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }

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
  if (entry.isDirectory() && SKIPPED_DIR_NAMES.has(entry.name)) {
    return true;
  }
  if (entry.isFile() && entry.name.endsWith('.xcuserstate')) {
    return true;
  }
  return entry.isFile() && !relativePath.includes(path.sep) && SKIPPED_ROOT_FILES.has(entry.name);
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
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--quiet') {
      parsed.quiet = true;
      continue;
    }
    if (arg === '--root') {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) {
        throw new Error('--root requires a path');
      }
      parsed.root = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
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
